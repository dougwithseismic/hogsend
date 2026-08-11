import type { emailTrustTierEnum } from "../db/schema/enums";
import type { SesReputationPolicy } from "../ses/types";

/**
 * THE ACCEPTABLE USE POLICY, AS CODE (PRD 08).
 *
 * Every threshold and every tier rule lives in this ONE module, and nothing
 * else in the codebase may write one of these numbers as a literal. The reason
 * is not tidiness: `docs/acceptable-use-policy.md` §5 PUBLISHES these numbers to
 * customers and the suspension notice quotes them back, so a magic `0.05`
 * inline is how the policy and the code drift apart six months from now — and a
 * policy that promises one number while the code enforces another is worse than
 * having no number at all.
 *
 * If a number changes, it changes HERE first and in the AUP in the same commit.
 * PRD 08 is the only place these may be defined; the AUP restates them.
 *
 * PURE: no database, no SES, no clock. Every rule below is a function over
 * values a test can hand it directly, which is what makes the policy provable
 * rather than merely implemented.
 *
 * All of these are PENDING Doug's sign-off (PRD 08 Locked decisions). They are
 * what the build enforces until he says otherwise.
 */

// ---------------------------------------------------------------------------
// The published numbers (AUP §5.1 and §5.2)
// ---------------------------------------------------------------------------

/**
 * The hard bounce rate at which we stop an environment ourselves.
 *
 * It is the rate at which AWS puts an entire ACCOUNT under review, which makes
 * it the last point at which one tenant is still our problem rather than AWS's.
 * We suspend at the review threshold rather than at the pause threshold (10%)
 * because every tenant sends through infrastructure we own.
 */
export const SUSPEND_BOUNCE_RATE = 0.05;

/** The complaint rate, same reasoning: AWS's account-review threshold. */
export const SUSPEND_COMPLAINT_RATE = 0.001;

/**
 * Messages a `new` tenant may send in one UTC day.
 *
 * This is the REAL bound on a new tenant's damage, because its reputation
 * policy is `NONE` and SES will therefore not auto-pause it. Low enough that a
 * bad first list cannot produce meaningful bounce volume.
 */
export const NEW_TIER_DAILY_CAP = 500;

/** Days of sending required before promotion to `established`. */
export const ESTABLISHED_MIN_DAYS = 14;

/** Messages delivered required before promotion. A record, not a trickle. */
export const ESTABLISHED_MIN_DELIVERED = 1000;

/**
 * The bounce ceiling for PROMOTION — deliberately stricter than the suspend
 * threshold. Promotion should require being comfortably clean, not merely
 * not-yet-suspended.
 */
export const ESTABLISHED_MAX_BOUNCE_RATE = 0.02;

/** The complaint ceiling for promotion. Same reasoning. */
export const ESTABLISHED_MAX_COMPLAINT_RATE = 0.0005;

/** A `watched` tenant's cap, as a fraction of the plan allowance. */
export const WATCHED_CAP_FRACTION = 0.25;

// ---------------------------------------------------------------------------
// The two numbers the AUP implies but does not print
// ---------------------------------------------------------------------------

/**
 * The minimum volume a rate is judged over.
 *
 * NOT one of the published numbers, and it is flagged for Doug because it is a
 * judgement the AUP gestures at without naming: §5.1 measures "over a
 * representative volume of your recent sending". Without a floor the rule is
 * broken rather than strict — one hard bounce on a tenant's first three test
 * messages is a 33% bounce rate, and suspending on it would suspend almost
 * every new customer on their first afternoon.
 *
 * 100 is a fifth of a `new` tenant's daily cap: enough that five bounces are
 * required to cross 5%, small enough that a genuinely bad first list is caught
 * on its first day.
 */
export const SUSPEND_MIN_VOLUME = 100;

/**
 * How far back "recent sending" reaches, in days.
 *
 * Also not published. It has to be longer than `ESTABLISHED_MIN_DAYS` or the
 * promotion criteria could never be observed in one window, and short enough
 * that a tenant is judged on what it is doing now rather than on a quarter-old
 * record it has already fixed.
 */
export const REPUTATION_WINDOW_DAYS = 30;

// ---------------------------------------------------------------------------
// Tiers
// ---------------------------------------------------------------------------

export type EmailTrustTier = (typeof emailTrustTierEnum.enumValues)[number];

export const EMAIL_TRUST_TIERS = [
  "new",
  "established",
  "watched",
] as const satisfies readonly EmailTrustTier[];

/**
 * Tier → the SES reputation policy that tier enforces (AUP §5.2).
 *
 * `NONE` for `new` is OBSERVATION, not permissiveness: AWS's own onboarding
 * guidance is to observe before enforcing, and a brand-new tenant auto-paused
 * by a single hard bounce on ten emails is a terrible first experience. The
 * send cap is what bounds the damage instead.
 */
const REPUTATION_POLICY_BY_TIER: Record<EmailTrustTier, SesReputationPolicy> = {
  new: "NONE",
  established: "STANDARD",
  watched: "STRICT",
};

export function tierReputationPolicy(
  tier: EmailTrustTier,
): SesReputationPolicy {
  return REPUTATION_POLICY_BY_TIER[tier];
}

/**
 * May this tier bulk-import a list?
 *
 * `established` only. DECISIONS §8 calls this the single highest-value abuse
 * control in the stack, because the scraped-list blast is the specific event
 * that damages aggregate reputation fastest. It is a STRUCTURAL block, not a
 * rate limit: there is no volume at which a tenant with no sending record may
 * perform a large first send to a list we have never seen.
 */
export function allowsBulkImport(tier: EmailTrustTier): boolean {
  return tier === "established";
}

export type TierCapWindow = "day" | "period";

export interface TierSendCap {
  window: TierCapWindow;
  limit: number;
}

/**
 * The tier's send cap, or null when the tier does not impose one.
 *
 * `established` returns NULL rather than the plan allowance on purpose. The
 * allowance is a separate gate with its own accounting, its own overage rule
 * and its own 402; restating it here would be two ceilings claiming to be the
 * same number, and the first time they disagreed one of them would be wrong.
 */
export function tierSendCap(input: {
  tier: EmailTrustTier;
  planAllowance: number;
}): TierSendCap | null {
  if (input.tier === "new") {
    return { window: "day", limit: NEW_TIER_DAILY_CAP };
  }
  if (input.tier === "watched") {
    return {
      window: "period",
      limit: Math.floor(input.planAllowance * WATCHED_CAP_FRACTION),
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// The stats every rule is judged over
// ---------------------------------------------------------------------------

/**
 * One tenant's recent sending, as the rules need it.
 *
 * `sent` is the denominator for both rates, matching AWS (which computes bounce
 * rate over sends) and matching the suspension notice, which tells a customer
 * the rate was measured "across N messages sent".
 */
export interface TrustTierStats {
  /** Distinct UTC days in the window on which this tenant sent anything. */
  sendingDays: number;
  /** Messages the relay accepted for the wire in the window. */
  sent: number;
  /** `email.delivered` events in the window. */
  delivered: number;
  bounced: number;
  complained: number;
}

export const EMPTY_TRUST_TIER_STATS: TrustTierStats = {
  sendingDays: 0,
  sent: 0,
  delivered: 0,
  bounced: 0,
  complained: 0,
};

/** Bounces over sends. Zero sends is a rate of zero, never a division. */
export function bounceRate(stats: TrustTierStats): number {
  return stats.sent > 0 ? stats.bounced / stats.sent : 0;
}

export function complaintRate(stats: TrustTierStats): number {
  return stats.sent > 0 ? stats.complained / stats.sent : 0;
}

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

export interface TrustTierDecision {
  tier: EmailTrustTier;
  changed: boolean;
  /** Why, in a sentence that goes into the audit row. */
  reason: string;
}

/**
 * What tier should this tenant be in?
 *
 * The order is the policy:
 *
 *  1. **Any open finding means `watched`, from any tier.** Demotion is
 *     automatic and immediate (AUP §5.2), and it outranks a clean send record —
 *     a finding is AWS telling us something the numbers have not shown yet.
 *  2. **`watched` never promotes here.** Promotion out of `watched` is a human
 *     review; an automatic reinstate on request is an automatic bypass, and
 *     SES's own `reinstated` state ignores active findings during recovery, so
 *     an unpause without a resolved root cause simply re-pauses later.
 *  3. **`new` promotes on ALL FOUR criteria**, never on a subset.
 */
export function decideTrustTier(input: {
  tier: EmailTrustTier;
  stats: TrustTierStats;
  /** How many findings are open for this tenant right now. */
  openFindings: number;
}): TrustTierDecision {
  const { tier, stats, openFindings } = input;

  if (openFindings > 0) {
    return {
      tier: "watched",
      changed: tier !== "watched",
      reason: `${openFindings} open reputation finding(s); AUP §5.2 demotes to watched automatically`,
    };
  }

  if (tier === "watched") {
    return {
      tier: "watched",
      changed: false,
      reason:
        "promotion out of watched is a human review (AUP §6.6), never automatic",
    };
  }

  if (tier === "established") {
    return { tier, changed: false, reason: "no change" };
  }

  const bounces = bounceRate(stats);
  const complaints = complaintRate(stats);
  const unmet: string[] = [];
  if (stats.sendingDays < ESTABLISHED_MIN_DAYS) {
    unmet.push(`${stats.sendingDays}/${ESTABLISHED_MIN_DAYS} sending days`);
  }
  if (stats.delivered < ESTABLISHED_MIN_DELIVERED) {
    unmet.push(`${stats.delivered}/${ESTABLISHED_MIN_DELIVERED} delivered`);
  }
  if (bounces > ESTABLISHED_MAX_BOUNCE_RATE) {
    unmet.push(`bounce rate ${formatRate(bounces)}`);
  }
  if (complaints > ESTABLISHED_MAX_COMPLAINT_RATE) {
    unmet.push(`complaint rate ${formatRate(complaints)}`);
  }

  if (unmet.length > 0) {
    return {
      tier: "new",
      changed: false,
      reason: `not yet established: ${unmet.join(", ")}`,
    };
  }

  return {
    tier: "established",
    changed: true,
    reason: `${stats.sendingDays} sending days, ${stats.delivered} delivered, bounce ${formatRate(
      bounces,
    )}, complaint ${formatRate(complaints)}`,
  };
}

export type SuspensionMetric = "hard bounce rate" | "complaint rate";

export type SuspensionVerdict =
  | { action: "none" }
  | {
      action: "suspend";
      metric: SuspensionMetric;
      /** The measured rate, as a fraction. */
      measured: number;
      threshold: number;
      /** Messages the rate was measured over. */
      volume: number;
      /** The AUP clause this cites. Load-bearing: the notice quotes it. */
      clause: "5.1";
    };

/**
 * Must we stop this tenant ourselves?
 *
 * SES's reputation policy does this for `established` and `watched` tenants,
 * which is why PRD 08 does not rebuild bounce-rate maths. This rule exists for
 * the case SES will NOT catch: a `new` tenant sits on reputation policy `NONE`
 * and will never be auto-paused however badly it sends, so without this the
 * daily cap would be its only bound and 500 bad messages a day is an indefinite
 * bleed on the aggregate account.
 *
 * Bounce is checked before complaint only so one verdict is returned; a tenant
 * over both is over both, and the notice names the one that decided it.
 */
export function decideSuspension(stats: TrustTierStats): SuspensionVerdict {
  // §5.1 measures over "a representative volume". Below the floor there is no
  // rate, only noise — see SUSPEND_MIN_VOLUME.
  if (stats.sent < SUSPEND_MIN_VOLUME) return { action: "none" };

  const bounces = bounceRate(stats);
  if (bounces >= SUSPEND_BOUNCE_RATE) {
    return {
      action: "suspend",
      metric: "hard bounce rate",
      measured: bounces,
      threshold: SUSPEND_BOUNCE_RATE,
      volume: stats.sent,
      clause: "5.1",
    };
  }

  const complaints = complaintRate(stats);
  if (complaints >= SUSPEND_COMPLAINT_RATE) {
    return {
      action: "suspend",
      metric: "complaint rate",
      measured: complaints,
      threshold: SUSPEND_COMPLAINT_RATE,
      volume: stats.sent,
      clause: "5.1",
    };
  }

  return { action: "none" };
}

/**
 * A rate as a customer-readable percentage.
 *
 * Two decimal places, trailing zeros trimmed: `0.0031` reads `0.31%` and
 * `0.05` reads `5%`. The suspension notice puts this number in front of an
 * angry customer, so it may not be `0.3100000000000001%`.
 */
export function formatRate(rate: number): string {
  const percent = rate * 100;
  const rounded = Math.round(percent * 100) / 100;
  return `${rounded}%`;
}

// ---------------------------------------------------------------------------
// Clause citations
// ---------------------------------------------------------------------------

/**
 * The AUP clauses this enforcement can cite, with their headings.
 *
 * Clause numbers are LOAD-BEARING: `docs/hogsend-email-terms.md` Part B quotes
 * them verbatim into a customer email, so renumbering a clause in the AUP
 * breaks a real message. This map is the one place the code names one.
 */
export const AUP_CLAUSES = {
  "2.2": "Purchased, rented or scraped lists",
  "3.2": "Phishing and impersonation",
  "3.3": "Malware",
  "3.7": "Evasion",
  "4.1": "Volume and rate",
  "5.1": "Reputation thresholds",
  "5.3": "Bulk import below established",
  "6.2": "Manual suspension",
} as const;

export type AupClause = keyof typeof AUP_CLAUSES;

/** The two clauses that have no appeal (AUP §6.7). */
export const NO_APPEAL_CLAUSES = ["3.2", "3.3"] as const;

export function hasAppeal(clause: string): boolean {
  return !(NO_APPEAL_CLAUSES as readonly string[]).includes(clause);
}

/** Where an appeal goes. Constant, per the notice's token table. */
export const APPEAL_EMAIL = "abuse@hogsend.com";
