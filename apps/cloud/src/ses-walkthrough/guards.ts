import type { AwsSesCredentials } from "../ses/aws";
import { SES_REGION_BY_SUBSTRATE_REGION } from "../ses/types";
import type { SubstrateRegion } from "../substrate/types";
import {
  DEFAULT_IDENTITY_BASE,
  isWalkthroughTenantName,
  WALKTHROUGH_TENANT_PREFIX,
} from "./naming";

/**
 * Everything that decides whether the walkthrough is allowed to touch AWS.
 *
 * This module is the reason the script is safe to have in the repository at
 * all. It creates billable, stateful resources in a real account, so the
 * default posture is REFUSAL and every path to "yes" is explicit:
 *
 *  1. the operator typed `--i-know-this-hits-aws`;
 *  2. BOTH credential variables are present (the same gate
 *     `src/ses/index.ts` uses to choose the real client — no second
 *     credential path exists);
 *  3. the target account holds no tenant this script did not create.
 *
 * Each of the three throws a `WalkthroughRefusal`, and the runner turns that
 * into a non-zero exit with the message. None of them may run AFTER a client
 * has been constructed, which is why they are pure functions over their inputs
 * rather than methods on something that already holds a connection.
 */

/** A deliberate refusal, as opposed to a failure. Always exits non-zero. */
export class WalkthroughRefusal extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WalkthroughRefusal";
    this.code = code;
  }
}

export const CONFIRMATION_FLAG = "--i-know-this-hits-aws";

/**
 * The SAME two variables `src/ses/index.ts` gates on. Restated as constants so
 * the refusal message can name them; the gate itself is still the factory's.
 */
export const ACCESS_KEY_VAR = "CLOUD_AWS_ACCESS_KEY_ID";
export const SECRET_KEY_VAR = "CLOUD_AWS_SECRET_ACCESS_KEY";

export interface WalkthroughOptions {
  confirmed: boolean;
  region: SubstrateRegion;
  /** An explicit identity domain. Overrides `identityBase` entirely. */
  identityDomain?: string;
  identityBase: string;
  /** The SNS topic the event-destination step publishes to, if any. */
  snsTopicArn?: string;
  /** A VERIFIED sender in the target account. Without it the send is skipped. */
  sendFrom?: string;
  /** In sandbox this must also be a verified address. */
  sendTo?: string;
  /** Pin the run id, for a reproducible name. */
  runId?: string;
  json: boolean;
  help: boolean;
}

const USAGE = `usage: ses-walkthrough ${CONFIRMATION_FLAG} [options]

Walks the whole SES contract against a REAL AWS account and reports every
place AWS disagrees with FakeSesClient. Creates and tears down real resources.

  ${CONFIRMATION_FLAG}    required; nothing happens without it
  --region <us|eu>          which SES region to walk (default: us)
  --identity-base <domain>  parent of the run-scoped identity
                            (default: ${DEFAULT_IDENTITY_BASE})
  --identity-domain <d>     use this domain verbatim instead
  --sns-topic-arn <arn>     exercise the event destination against this topic
  --send-from <address>     a VERIFIED sender; without it the send is skipped
  --send-to <address>       in sandbox this must be verified too
  --run-id <id>             pin the run id (default: derived from the clock)
  --json                    emit the report as JSON as well as text
`;

/**
 * Parse, refusing anything unrecognised.
 *
 * An unknown flag is a REFUSAL rather than a warning: a typo in
 * `--i-know-this-hits-aws` must not silently become "no flag given, but here
 * is a run anyway", and a typo in `--send-to` must not silently send nowhere.
 */
export function parseWalkthroughArgs(argv: string[]): WalkthroughOptions {
  const options: WalkthroughOptions = {
    confirmed: false,
    region: "us",
    identityBase: DEFAULT_IDENTITY_BASE,
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
      case CONFIRMATION_FLAG:
        options.confirmed = true;
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
      case "--identity-base":
        options.identityBase = next();
        break;
      case "--identity-domain":
        options.identityDomain = next();
        break;
      case "--sns-topic-arn":
        options.snsTopicArn = next();
        break;
      case "--send-from":
        options.sendFrom = next();
        break;
      case "--send-to":
        options.sendTo = next();
        break;
      case "--run-id":
        options.runId = next();
        break;
      case "--json":
        options.json = true;
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      default:
        throw new WalkthroughRefusal(
          "bad_argument",
          `unknown argument ${JSON.stringify(arg)}\n\n${USAGE}`,
        );
    }
  }

  return options;
}

export function walkthroughUsage(): string {
  return USAGE;
}

/** Refuse unless the operator said the words. Nothing has touched AWS yet. */
export function requireConfirmation(options: WalkthroughOptions): void {
  if (options.confirmed) return;
  throw new WalkthroughRefusal(
    "not_confirmed",
    `refusing to run: this script creates and deletes REAL AWS SES resources and bills a real account. Re-run with ${CONFIRMATION_FLAG} if that is what you want.\n\n${USAGE}`,
  );
}

/**
 * BOTH variables, or nothing.
 *
 * The message names BOTH in every case, including when only one is missing:
 * an operator who exported one of a pair needs to see the pair, and the
 * factory's own rule (`src/ses/index.ts`) is that exactly one set is a
 * misconfiguration rather than a degraded mode.
 *
 * This runs BEFORE any client is constructed, and that ordering is the whole
 * point. `getSesClient` answers a missing credential pair with `FakeSesClient`
 * — correct for the control plane, useless here: a walkthrough that silently
 * compared the Fake against the Fake would report zero divergences and prove
 * nothing at all.
 */
export function requireAwsCredentials(
  source: Record<string, string | undefined>,
): AwsSesCredentials {
  const accessKeyId = source[ACCESS_KEY_VAR]?.trim();
  const secretAccessKey = source[SECRET_KEY_VAR]?.trim();
  if (accessKeyId && secretAccessKey) return { accessKeyId, secretAccessKey };

  const missing = [
    accessKeyId ? null : ACCESS_KEY_VAR,
    secretAccessKey ? null : SECRET_KEY_VAR,
  ].filter((name): name is string => name !== null);

  throw new WalkthroughRefusal(
    "no_credentials",
    `refusing to run: this script must talk to a REAL SES account, and ${missing.join(
      " and ",
    )} ${missing.length === 1 ? "is" : "are"} not set. Export BOTH ${ACCESS_KEY_VAR} and ${SECRET_KEY_VAR} for the walkthrough's target account. No AWS client was constructed.`,
  );
}

export interface AccountCensus {
  /** Tenants left by an earlier run of THIS script. Sweepable, not fatal. */
  leftovers: string[];
}

/**
 * Refuse to run against an account that holds a tenant we did not create.
 *
 * The failure this prevents is running the walkthrough against
 * `hogsend-email-prod` with live customers on it: every step here is
 * destructive by design, a teardown bug would reach real tenants, and the
 * account-level throttle it burns is shared with real sending.
 *
 * A leftover from an earlier walkthrough run is NOT a refusal — it is the
 * expected residue of a crash, and reporting it is how it gets swept. Refusing
 * on it would mean one crashed run permanently blocks the script, which is the
 * kind of guard people disable.
 */
export function assertAccountSweepable(
  tenantNames: readonly string[],
): AccountCensus {
  const foreign = tenantNames.filter((name) => !isWalkthroughTenantName(name));
  if (foreign.length > 0) {
    throw new WalkthroughRefusal(
      "account_not_empty",
      `refusing to run: the target account already holds ${foreign.length} SES tenant(s) this script did not create — ${foreign
        .slice(0, 10)
        .join(
          ", ",
        )}${foreign.length > 10 ? ", …" : ""}. Every tenant this script recognises is named ${WALKTHROUGH_TENANT_PREFIX}*. Point CLOUD_AWS_ACCESS_KEY_ID/CLOUD_AWS_SECRET_ACCESS_KEY at a scratch account.`,
    );
  }
  return { leftovers: tenantNames.filter(isWalkthroughTenantName) };
}
