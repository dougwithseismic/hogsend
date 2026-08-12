import { randomBytes } from "node:crypto";
import type { CloudDb } from "../db";
import { db as defaultDb } from "../db";
import { AWS_SES_ID, type AwsSesCredentials } from "../ses/aws";
import { resolveSesRegion, type SesClient } from "../ses/contract";
import { getSesClient } from "../ses/index";
import type { SesRegion } from "../ses/types";
import { awsTenantCensus, type TenantCensus } from "../ses-walkthrough/census";
import {
  assertAccountSweepable,
  requireAwsCredentials,
  WalkthroughRefusal,
} from "../ses-walkthrough/guards";
import { walkthroughRunId } from "../ses-walkthrough/naming";
import { scrub } from "../ses-walkthrough/report";
import type { SubstrateRegion } from "../substrate/types";
import {
  parseProofArgs,
  proofUsage,
  requireProofConfirmation,
  requirePublicUrl,
  requireSendFrom,
  resolveProofTopicArn,
} from "./guards";
import { proofNames } from "./naming";
import { executeProof, PROOF_LINK_TITLES } from "./proof";
import { type DeliveryProofReport, renderProofReport } from "./report";
import { awsProofSnsClient, type ProofSnsClient } from "./sns";

/**
 * The runner: guards, the tunnel preflight, the proof, the report, an exit
 * code — the same shape as `ses-walkthrough/run.ts`, and the same safety
 * property: nothing that could construct an AWS client, and nothing that could
 * make an AWS call, runs before every guard has passed. That is why
 * `resolveClient`, the census and the SNS factory are injected — a test can
 * prove none of them was reached.
 *
 * One guard is NEW and sits deliberately BEFORE the first AWS call: the tunnel
 * health preflight. A tunnel that is not up is the single most likely operator
 * error, it costs one local-ish GET to detect, and detecting it after
 * provisioning would mean a teardown nobody asked for.
 */

const TUNNEL_PREFLIGHT_TIMEOUT_MS = 10_000;

export interface DeliveryProofDeps {
  env?: Record<string, string | undefined>;
  /** Injected so a test can prove no client is constructed before the guards. */
  resolveClient?: (region: SubstrateRegion) => SesClient;
  census?: (input: {
    awsRegion: SesRegion;
    credentials: AwsSesCredentials;
  }) => TenantCensus;
  snsFactory?: (input: {
    awsRegion: SesRegion;
    credentials: AwsSesCredentials;
  }) => ProofSnsClient;
  db?: CloudDb;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  entropy?: () => string;
  /** Pinned in tests; a real run mints a fresh one per run. */
  webhookSecret?: string;
  out?: (line: string) => void;
}

export interface DeliveryProofRunResult {
  exitCode: number;
  report?: DeliveryProofReport;
  /** Set instead of `report` when a guard refused. */
  refusal?: { code: string; message: string };
}

export async function runDeliveryProof(
  argv: string[],
  deps: DeliveryProofDeps = {},
): Promise<DeliveryProofRunResult> {
  const out = deps.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? fetch;

  let cleared: {
    options: ReturnType<typeof parseProofArgs>;
    credentials: AwsSesCredentials;
    publicUrl: string;
    sendFrom: string;
    topicArn: string;
  } | null = null;
  try {
    const options = parseProofArgs(argv);
    if (options.help) {
      out(proofUsage());
      return { exitCode: 0 };
    }
    // 1. The operator said the words. Nothing has touched anything.
    requireProofConfirmation(options);
    // 2. BOTH credential vars — the walkthrough's guard, reused, and for the
    //    same reason: `getSesClient` would otherwise hand back the Fake and
    //    this script would "prove" delivery against an account that does not
    //    exist.
    const credentials = requireAwsCredentials(env);
    // 3. Shape guards that need no network: the https tunnel URL, the
    //    required sender, and the fail-closed topic.
    const publicUrl = requirePublicUrl(options.publicUrl);
    const sendFrom = requireSendFrom(options.sendFrom);
    const topicArn = resolveProofTopicArn(options, env);
    cleared = { options, credentials, publicUrl, sendFrom, topicArn };
  } catch (error) {
    return refuse(error, out);
  }
  const { options, credentials, publicUrl, sendFrom, topicArn } = cleared;

  // 4. The tunnel answers. Still no AWS call has been made.
  const healthUrl = `${publicUrl}/api/health`;
  try {
    const response = await fetchImpl(healthUrl, {
      signal: AbortSignal.timeout(TUNNEL_PREFLIGHT_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`it answered ${response.status}`);
    }
  } catch (error) {
    return refuse(
      new WalkthroughRefusal(
        "tunnel_down",
        `refusing to run: ${healthUrl} did not answer 200 (${
          error instanceof Error ? error.message : String(error)
        }). Start the control plane (pnpm --filter @hogsend/cloud dev) and the tunnel (cloudflared tunnel --url http://localhost:3004), then pass the tunnel's https URL. Nothing was created.`,
      ),
      out,
    );
  }

  const awsRegion = resolveSesRegion(options.region);

  // 5. The account holds nothing we did not make. The FIRST AWS call, and it
  //    is read-only. Reuses the walkthrough's census + sweepable guard, so a
  //    crashed proof run's leftovers are the same sweepable residue a crashed
  //    walkthrough leaves.
  let leftoverTenants: string[];
  try {
    const census = (deps.census ?? awsTenantCensus)({ awsRegion, credentials });
    leftoverTenants = assertAccountSweepable(await census()).leftovers;
  } catch (error) {
    if (error instanceof WalkthroughRefusal) return refuse(error, out);
    out(
      `✗ could not list the account's SES tenants, so the account-safety guard cannot clear this run: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { exitCode: 1 };
  }

  const real = (deps.resolveClient ?? getSesClient)(options.region);
  if (real.id !== AWS_SES_ID) {
    // Belt and braces behind the credential guard, exactly as the walkthrough
    // holds it: a delivery "proof" against the Fake proves nothing.
    out(
      `✗ refusing to run: the resolved SES client is "${real.id}", not "${AWS_SES_ID}". This script only proves something against real AWS.`,
    );
    return { exitCode: 1 };
  }

  const runId =
    options.runId ??
    walkthroughRunId(
      (deps.now ?? (() => new Date()))(),
      (deps.entropy ?? (() => randomBytes(3).toString("hex")))(),
    );
  const names = proofNames(runId);
  const webhookSecret = deps.webhookSecret ?? randomBytes(24).toString("hex");
  const sns = (deps.snsFactory ?? awsProofSnsClient)({
    awsRegion,
    credentials,
  });

  out(
    `▶ proving the delivery path as run ${runId} in ${awsRegion}. Every resource is named ${names.tenantName}* and torn down at the end, including on failure.`,
  );

  const executed = await executeProof({
    client: real,
    sns,
    db: deps.db ?? defaultDb,
    names,
    region: options.region,
    sendFrom,
    publicUrl,
    topicArn,
    webhookSecret,
    observeSeconds: options.observeSeconds,
    ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
    out,
  });

  const report: DeliveryProofReport = {
    runId,
    region: options.region,
    awsRegion,
    clientId: real.id,
    publicUrl,
    sendFrom,
    topicArn,
    names,
    leftoverTenants,
    links: [
      {
        id: "tunnel_health",
        title: PROOF_LINK_TITLES.tunnel_health,
        status: "exercised",
        detail: `${healthUrl} answered 200 before anything was created`,
      },
      ...executed.links,
    ],
    steps: executed.steps,
    events: executed.events,
    stub: executed.stub,
    findings: executed.findings,
    notes: executed.notes,
    cleanup: executed.cleanup,
    ...(executed.probeMessageId === undefined
      ? {}
      : { probeMessageId: executed.probeMessageId }),
    ...(executed.aborted === undefined ? {} : { aborted: executed.aborted }),
  };

  // The webhook secret signs the hop and never belongs in output; scrubbing
  // the WHOLE rendered string covers whatever an error body quoted verbatim.
  const secrets = [webhookSecret];
  out(scrub(renderProofReport(report), secrets));
  if (options.json) {
    out(scrub(JSON.stringify(report, null, 2), secrets));
  }

  // Non-zero on ANY failed link, any finding, any leaked resource, or an
  // abort. A finding is a real result — the run "worked" — but a green exit on
  // a suppressed simulator bounce is how the finding gets ignored.
  const failed =
    report.links.some((link) => link.status === "failed") ||
    report.findings.length > 0 ||
    report.cleanup.failed.length > 0 ||
    report.aborted !== undefined;
  return { exitCode: failed ? 1 : 0, report };
}

function refuse(
  error: unknown,
  out: (line: string) => void,
): DeliveryProofRunResult {
  if (error instanceof WalkthroughRefusal) {
    out(`✗ ${error.message}`);
    return {
      exitCode: 1,
      refusal: { code: error.code, message: error.message },
    };
  }
  out(`✗ ${error instanceof Error ? error.message : String(error)}`);
  return { exitCode: 1 };
}
