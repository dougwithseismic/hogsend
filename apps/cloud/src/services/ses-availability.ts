import { AWS_SES_ID } from "../ses/aws";
import type { SesClient } from "../ses/contract";

/**
 * Whether Hogsend Email may be ACTIVATED for a newly provisioned environment.
 *
 * The question this answers is "can this account send mail?", and it replaced
 * one that only looked like it: `ses.id === AWS_SES_ID`, which answers "do we
 * hold real AWS credentials". Those are different, and the gap between them is
 * the SES SANDBOX — until AWS grants production access an account may only
 * mail identities it verified itself, capped at 200 messages a day, and
 * refuses everything else with `MessageRejected`. The account is in the
 * sandbox TODAY, so the moment the credentials were promoted to Railway the
 * old check would have activated Hogsend Email on every provision and every
 * customer send would have failed.
 *
 * Three properties, in the order they matter:
 *
 *  - **Fail CLOSED.** Unreadable, ambiguous, or a throw is NOT available. An
 *    instance that does not activate Hogsend Email is a working instance on
 *    another provider; one that activates it on an account that cannot send is
 *    a broken product.
 *  - **The answer is CACHED per region.** Production access is an account
 *    fact, granted region by region by an AWS human, and it does not change
 *    between two provisions a minute apart. A provision must not pay an AWS
 *    round trip to re-learn it — it already makes a dozen calls that matter.
 *  - **The reason travels with the refusal.** `available: false` alone reads
 *    like the step silently did nothing; the reason is what an operator sees
 *    in the provision record instead.
 */

/** Why activation was refused. `null` reason ⇔ `available: true`. */
export type SesUnavailableReason =
  /** No AWS credentials: the tenancy was minted against the in-memory Fake. */
  | "no-aws-credentials"
  /** Real credentials, sandbox account — verified recipients only. */
  | "sandbox"
  /** AWS has paused the whole account's sending. Every tenant is down. */
  | "account-sending-paused"
  /** The account state could not be read. Indeterminate, so: closed. */
  | "account-unreadable";

export interface SesAvailability {
  available: boolean;
  reason: SesUnavailableReason | null;
  /** One sentence, written for an operator reading a provision record. */
  detail: string;
}

/**
 * How long a READ account answer is trusted.
 *
 * Ten minutes is the trade: a provision effectively never pays for the read,
 * and production access arriving from AWS goes live on its own within ten
 * minutes rather than waiting for a control-plane redeploy.
 */
export const SES_ACCOUNT_TTL_MS = 10 * 60_000;

export interface SesAvailabilityOptions {
  /** Injectable clock, for the TTL. Defaults to `Date.now`. */
  now?: () => number;
  ttlMs?: number;
}

interface CacheEntry {
  answer: SesAvailability;
  readAt: number;
}

/**
 * Keyed by CLIENT ID **and** region. Both halves are load-bearing: sandbox
 * status is per AWS region, and a test driving the Fake must never read an
 * answer the AWS client cached (or the reverse).
 */
const cache = new Map<string, CacheEntry>();

export async function resolveSesAvailability(
  ses: SesClient,
  options: SesAvailabilityOptions = {},
): Promise<SesAvailability> {
  // No credentials is a MODE, not a failure: the Fake minted the tenancy, so
  // there is no account to read and nothing to cache. Activating over the Fake
  // would be silent non-delivery — every send "succeeding" against an
  // in-memory client while no mail ever leaves.
  if (ses.id !== AWS_SES_ID) {
    return {
      available: false,
      reason: "no-aws-credentials",
      detail:
        "the control plane holds no AWS credentials, so this environment's " +
        `SES tenancy was minted against the in-memory fake ("${ses.id}")`,
    };
  }

  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? SES_ACCOUNT_TTL_MS;
  const key = `${ses.id}:${ses.region}`;
  const at = now();

  const cached = cache.get(key);
  if (cached && at - cached.readAt < ttlMs) return cached.answer;

  let answer: SesAvailability;
  try {
    const account = await ses.getAccount();
    answer = classify(account, ses.awsRegion);
  } catch (cause) {
    // Deliberately NOT cached. A throttle or a redeploy blip must not pin the
    // whole fleet to "unavailable" for the full TTL — that would provision
    // every instance in that window onto the wrong provider, and each one
    // needs a re-provision to correct. One extra read per provision while AWS
    // is unreachable is the cheaper failure.
    return {
      available: false,
      reason: "account-unreadable",
      detail:
        `the SES account in ${ses.awsRegion} could not be read ` +
        `(ses:GetAccount: ${message(cause)}), so Hogsend Email was left ` +
        "inactive rather than assumed sendable",
    };
  }

  cache.set(key, { answer, readAt: at });
  return answer;
}

/** Drop every cached account answer. Tests, and any operator-facing recheck. */
export function resetSesAvailabilityCache(): void {
  cache.clear();
}

function classify(
  account: {
    productionAccessEnabled: boolean;
    sendingEnabled: boolean;
    max24HourSend?: number;
  },
  awsRegion: string,
): SesAvailability {
  if (!account.productionAccessEnabled) {
    const cap =
      account.max24HourSend === undefined
        ? ""
        : `, capped at ${account.max24HourSend} messages a day`;
    return {
      available: false,
      reason: "sandbox",
      detail:
        `the SES account is in the SANDBOX in ${awsRegion} ` +
        "(ProductionAccessEnabled=false): it can only send to identities we " +
        `verified ourselves${cap}, so Hogsend Email was not activated`,
    };
  }
  // Checked AFTER the sandbox, because a sandbox account also reports sending
  // enabled and the sandbox is the more useful thing to tell an operator.
  if (!account.sendingEnabled) {
    return {
      available: false,
      reason: "account-sending-paused",
      detail:
        `SES account-level sending is DISABLED in ${awsRegion} ` +
        "(SendingEnabled=false): every tenant is down until AWS resumes it",
    };
  }
  return {
    available: true,
    reason: null,
    detail: `the SES account has production access in ${awsRegion}`,
  };
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
