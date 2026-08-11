import { SES_REGION_BY_SUBSTRATE_REGION } from "../ses/types";
import { domainOfAddress } from "../ses-walkthrough/arns";
import {
  CONFIRMATION_FLAG,
  WalkthroughRefusal,
} from "../ses-walkthrough/guards";
import type { SubstrateRegion } from "../substrate/types";

/**
 * Everything that decides whether the delivery proof may touch AWS, the
 * network, or a mailbox.
 *
 * The refusal machinery is the walkthrough's, imported: same
 * `WalkthroughRefusal`, same `--i-know-this-hits-aws` flag, same
 * both-credentials rule (`requireAwsCredentials`, reused at the call site in
 * `run.ts`), same account-sweep guard. What is NEW here are the guards this
 * script needs and the walkthrough does not:
 *
 *  - a REQUIRED public HTTPS URL (the cloudflared quick tunnel) — SNS will not
 *    confirm an http endpoint, and a typo'd URL discovered after provisioning
 *    means a teardown nobody asked for;
 *  - a REQUIRED verified sender — this script's whole purpose is to deliver;
 *  - a fail-closed SNS topic — mirroring `sns/topics.ts`: no configured topic
 *    means NO run, never "any topic";
 *  - the simulator-only recipient rule — a test that emails a person is a test
 *    nobody runs twice.
 */

/** Re-exported so the proof's callers need only this module. */
export const PROOF_CONFIRMATION_FLAG = CONFIRMATION_FLAG;

/** The one domain this script may ever address mail to. */
export const SIMULATOR_DOMAIN = "simulator.amazonses.com";

/** The scenarios the proof sends, in send order. */
export const PROOF_SCENARIOS = ["success", "bounce", "complaint"] as const;
export type ProofScenario = (typeof PROOF_SCENARIOS)[number];

export const DEFAULT_OBSERVE_SECONDS = 180;

/** The env var each region's topic ARN lives in (`sns/topics.ts`). */
export const SNS_TOPIC_VAR_BY_REGION: Record<SubstrateRegion, string> = {
  us: "CLOUD_SES_SNS_TOPIC_ARN_US",
  eu: "CLOUD_SES_SNS_TOPIC_ARN_EU",
};

export interface ProofOptions {
  confirmed: boolean;
  region: SubstrateRegion;
  publicUrl?: string;
  sendFrom?: string;
  snsTopicArn?: string;
  runId?: string;
  observeSeconds: number;
  json: boolean;
  help: boolean;
}

const USAGE = `usage: ses-delivery-proof ${PROOF_CONFIRMATION_FLAG} --public-url <url> --send-from <address> [options]

Sends real messages through real SES to the mailbox simulator and watches each
event travel SES → SNS → the local control plane → the signed instance hop.
Creates and tears down real AWS resources and run-scoped database rows.

Before running: start the control plane (pnpm --filter @hogsend/cloud dev) and
a quick tunnel in front of it (cloudflared tunnel --url http://localhost:3004),
and export the SAME CLOUD_DATABASE_URL / CLOUD_ENCRYPTION_SECRET the control
plane uses — the script registers rows the control plane must read back.

  ${PROOF_CONFIRMATION_FLAG}    required; nothing happens without it
  --public-url <url>        REQUIRED. The tunnel's https URL fronting :3004
  --send-from <address>     REQUIRED. A VERIFIED sender in the target account
  --region <us|eu>          which SES region to prove (default: us)
  --sns-topic-arn <arn>     the region's event topic (default: the
                            CLOUD_SES_SNS_TOPIC_ARN_US/_EU env var)
  --run-id <id>             pin the run id (default: derived from the clock)
  --observe-seconds <n>     how long to wait for events (default: ${DEFAULT_OBSERVE_SECONDS})
  --json                    emit the report as JSON as well as text

Recipients are FIXED to the SES mailbox simulator (${SIMULATOR_DOMAIN}).
There is deliberately no flag that can aim this script at a real inbox.
`;

/**
 * Parse, refusing anything unrecognised — the walkthrough's rule, restated
 * because the stakes are higher here: this script DELIVERS, so a typo'd flag
 * silently ignored could mean a run whose safety property nobody chose.
 */
export function parseProofArgs(argv: string[]): ProofOptions {
  const options: ProofOptions = {
    confirmed: false,
    region: "us",
    observeSeconds: DEFAULT_OBSERVE_SECONDS,
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = (): string => {
      index += 1;
      const value = argv[index];
      if (value === undefined || value.startsWith("--")) {
        throw new WalkthroughRefusal(
          "bad_argument",
          `${arg} needs a value\n\n${USAGE}`,
        );
      }
      return value;
    };

    switch (arg) {
      // pnpm forwards the `--` separator from the documented invocation
      // (`pnpm --filter @hogsend/cloud ses:delivery-proof -- --i-know…`)
      // into argv verbatim. It is a separator, not a flag: skipping it can
      // mask no typo, and refusing it would refuse the documented command.
      case "--":
        break;
      case PROOF_CONFIRMATION_FLAG:
        options.confirmed = true;
        break;
      case "--public-url":
        options.publicUrl = next();
        break;
      case "--send-from":
        options.sendFrom = next();
        break;
      case "--region": {
        const value = next();
        if (!(value in SES_REGION_BY_SUBSTRATE_REGION)) {
          throw new WalkthroughRefusal(
            "bad_argument",
            `--region ${JSON.stringify(value)} is not a substrate region; expected one of ${Object.keys(
              SES_REGION_BY_SUBSTRATE_REGION,
            ).join(", ")}`,
          );
        }
        options.region = value as SubstrateRegion;
        break;
      }
      case "--sns-topic-arn":
        options.snsTopicArn = next();
        break;
      case "--run-id":
        options.runId = next();
        break;
      case "--observe-seconds": {
        const value = Number(next());
        if (!Number.isInteger(value) || value <= 0) {
          throw new WalkthroughRefusal(
            "bad_argument",
            `--observe-seconds needs a positive integer\n\n${USAGE}`,
          );
        }
        options.observeSeconds = value;
        break;
      }
      case "--json":
        options.json = true;
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      // A DEDICATED refusal rather than falling through to "unknown argument":
      // an operator reaching for --send-to is trying to redirect delivery, and
      // the answer has to be the rule, not a parse error.
      case "--send-to":
      case "--to":
      case "--recipient":
        throw new WalkthroughRefusal(
          "simulator_only",
          `${arg} is refused: this script sends ONLY to the SES mailbox simulator (${SIMULATOR_DOMAIN}). A test that emails a real inbox is a test nobody runs twice.\n\n${USAGE}`,
        );
      default:
        throw new WalkthroughRefusal(
          "bad_argument",
          `unknown argument ${JSON.stringify(arg)}\n\n${USAGE}`,
        );
    }
  }

  return options;
}

export function proofUsage(): string {
  return USAGE;
}

/**
 * A NEW confirmation guard rather than the walkthrough's, because the refusal
 * has to say what THIS script does — it delivers real mail and registers rows
 * in the control-plane database — and print this script's usage. The flag and
 * the refusal class are still the shared ones.
 */
export function requireProofConfirmation(options: {
  confirmed: boolean;
}): void {
  if (options.confirmed) return;
  throw new WalkthroughRefusal(
    "not_confirmed",
    `refusing to run: this script sends REAL email through a REAL AWS account, creates and deletes real SES resources, and registers run-scoped rows in the control-plane database. Re-run with ${PROOF_CONFIRMATION_FLAG} if that is what you want.\n\n${USAGE}`,
  );
}

/**
 * The tunnel URL must parse and must be https. SNS refuses to confirm plain
 * http against anything but localhost anyway, so accepting one here would only
 * defer the failure until AFTER provisioning — the exact teardown-nobody-asked
 * -for this guard exists to prevent. Trailing slashes are stripped so the
 * endpoint paths appended later cannot double a slash.
 */
export function requirePublicUrl(publicUrl: string | undefined): string {
  if (!publicUrl) {
    throw new WalkthroughRefusal(
      "bad_public_url",
      `refusing to run: --public-url is required — the cloudflared quick-tunnel https URL fronting the local control plane (cloudflared tunnel --url http://localhost:3004).\n\n${USAGE}`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(publicUrl);
  } catch {
    throw new WalkthroughRefusal(
      "bad_public_url",
      `refusing to run: --public-url ${JSON.stringify(publicUrl)} is not a URL.`,
    );
  }
  if (parsed.protocol !== "https:") {
    throw new WalkthroughRefusal(
      "bad_public_url",
      `refusing to run: --public-url must be https (got ${JSON.stringify(publicUrl)}). SNS will not deliver events to a plain-http endpoint, so the run would provision and then wait forever.`,
    );
  }
  return publicUrl.replace(/\/+$/, "");
}

/** The sender is REQUIRED: unlike the walkthrough, this script's whole job is
 * to deliver, so there is no legal sender-less run to degrade into. */
export function requireSendFrom(sendFrom: string | undefined): string {
  if (sendFrom) return sendFrom;
  throw new WalkthroughRefusal(
    "no_sender",
    `refusing to run: --send-from is required — a sender identity the target account has already VERIFIED. Create one and click its verification email first.\n\n${USAGE}`,
  );
}

/**
 * `--sns-topic-arn`, else the region's env var — and with NEITHER, a refusal.
 * Same fail-closed posture as `sns/topics.ts`: an unconfigured topic must
 * never mean "any topic", and here it also means the account owner has not run
 * `scripts/aws-bootstrap-events.sh` yet, which the message says out loud.
 */
export function resolveProofTopicArn(
  options: Pick<ProofOptions, "snsTopicArn" | "region">,
  source: Record<string, string | undefined>,
): string {
  const varName = SNS_TOPIC_VAR_BY_REGION[options.region];
  const topicArn = options.snsTopicArn ?? source[varName]?.trim();
  if (topicArn) return topicArn;
  throw new WalkthroughRefusal(
    "no_topic",
    `refusing to run: no SNS topic for region "${options.region}". Pass --sns-topic-arn or export ${varName} (scripts/aws-bootstrap-events.sh creates the topics and prints both values).`,
  );
}

/** The labelled scenario address: `bounce+<runId>@simulator.amazonses.com`. */
export function simulatorRecipient(
  scenario: ProofScenario,
  runId: string,
): string {
  return `${scenario}+${runId}@${SIMULATOR_DOMAIN}`;
}

/**
 * The last line of the simulator-only rule. The recipients are derived by
 * {@link simulatorRecipient} and there is no flag to override them, so this
 * can only fire on a future edit — which is exactly who it is for: the guard
 * runs immediately before anything is provisioned, so a change that reroutes
 * delivery fails in a test, not in somebody's inbox.
 */
export function requireSimulatorRecipient(address: string): void {
  if (domainOfAddress(address) === SIMULATOR_DOMAIN) return;
  throw new WalkthroughRefusal(
    "simulator_only",
    `refusing to send to ${JSON.stringify(address)}: this script sends ONLY to the SES mailbox simulator (${SIMULATOR_DOMAIN}).`,
  );
}
