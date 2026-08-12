import { randomBytes } from "node:crypto";
import { type DkimKeypair, generateDkimKeypair } from "../lib/sending-domains";
import { AWS_SES_ID, type AwsSesCredentials } from "../ses/aws";
import { resolveSesRegion, type SesClient } from "../ses/contract";
import { FakeSesClient } from "../ses/fake";
import { getSesClient } from "../ses/index";
import type { SesRegion } from "../ses/types";
import type { SubstrateRegion } from "../substrate/types";
import { awsTenantCensus, type TenantCensus } from "./census";
import {
  assertAccountSweepable,
  parseWalkthroughArgs,
  requireAwsCredentials,
  requireConfirmation,
  type WalkthroughOptions,
  WalkthroughRefusal,
  walkthroughUsage,
} from "./guards";
import { walkthroughNames, walkthroughRunId } from "./naming";
import { renderReport, scrub, type WalkthroughReport } from "./report";
import { executeWalkthrough } from "./walkthrough";

/**
 * The runner: guards, then the walk, then the report, then an exit code.
 *
 * The ORDER of the first four lines of `runWalkthrough` is the safety property
 * this whole PRD rests on. Nothing that could construct an AWS client, and
 * nothing that could make an AWS call, may run before all three guards have
 * passed — which is why `resolveClient` is injected rather than imported at the
 * call site: a test can prove it was never reached.
 */

export interface WalkthroughRunResult {
  exitCode: number;
  report?: WalkthroughReport;
  /** Set instead of `report` when a guard refused. */
  refusal?: { code: string; message: string };
}

export interface WalkthroughDeps {
  env?: Record<string, string | undefined>;
  /** Injected so a test can prove no client is constructed before the guards. */
  resolveClient?: (region: SubstrateRegion) => SesClient;
  census?: (input: {
    awsRegion: SesRegion;
    credentials: { accessKeyId: string; secretAccessKey: string };
  }) => TenantCensus;
  now?: () => Date;
  entropy?: () => string;
  keypair?: DkimKeypair;
  out?: (line: string) => void;
}

export async function runWalkthrough(
  argv: string[],
  deps: WalkthroughDeps = {},
): Promise<WalkthroughRunResult> {
  const out = deps.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const env = deps.env ?? process.env;

  let cleared: {
    options: WalkthroughOptions;
    credentials: AwsSesCredentials;
  } | null = null;
  try {
    const options = parseWalkthroughArgs(argv);
    if (options.help) {
      out(walkthroughUsage());
      return { exitCode: 0 };
    }
    // 1. The operator said the words. Nothing has touched AWS.
    requireConfirmation(options);
    // 2. BOTH credential vars. Still nothing has touched AWS — and this is the
    //    guard that stops `getSesClient` from silently handing back the Fake
    //    and turning the whole run into a comparison of the Fake with itself.
    cleared = { options, credentials: requireAwsCredentials(env) };
  } catch (error) {
    return refuse(error, out);
  }
  const { options, credentials } = cleared;

  const awsRegion = resolveSesRegion(options.region);

  // 3. The account holds nothing we did not make. The FIRST AWS call, and it
  //    is read-only — see `census.ts` for why it does not go through the seam.
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
    // Belt and braces behind the credential guard. Reaching this means the
    // factory chose the Fake with both variables set, and a walkthrough
    // comparing the Fake against the Fake would report a triumphant zero.
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
  const names = walkthroughNames({
    runId,
    identityBase: options.identityBase,
    ...(options.identityDomain
      ? { identityDomain: options.identityDomain }
      : {}),
  });
  const keypair = deps.keypair ?? generateDkimKeypair();

  out(
    `▶ walking the SES contract as run ${runId} in ${awsRegion}. Every resource is named ${names.tenantName}* and torn down at the end, including on failure.`,
  );

  const executed = await executeWalkthrough({
    real,
    fake: new FakeSesClient({ region: options.region }),
    options,
    names,
    keypair,
  });

  const report: WalkthroughReport = {
    runId,
    region: options.region,
    awsRegion,
    clientId: real.id,
    names,
    leftoverTenants,
    steps: executed.steps,
    divergences: executed.divergences,
    cleanup: executed.cleanup,
    dkim: executed.dkim,
    notes: executed.notes,
    ...(executed.aborted === undefined ? {} : { aborted: executed.aborted }),
  };

  // The private key never belongs in output. The redaction at the call site
  // covers what we remembered; this covers AWS's verbatim error body, which is
  // the part nobody remembers.
  const secrets = [keypair.privateKey];
  out(scrub(renderReport(report), secrets));
  if (options.json) {
    out(scrub(JSON.stringify(report, null, 2), secrets));
  }

  // Non-zero on ANY divergence (PRD 11's last acceptance criterion), and also
  // on a resource we could not remove: a leaked tenant bills, and a green exit
  // on a leak is how it stays leaked.
  const failed =
    report.divergences.length > 0 ||
    report.cleanup.failed.length > 0 ||
    report.aborted !== undefined;
  return { exitCode: failed ? 1 : 0, report };
}

function refuse(
  error: unknown,
  out: (line: string) => void,
): WalkthroughRunResult {
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
