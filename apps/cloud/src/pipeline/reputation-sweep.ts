import { eq } from "drizzle-orm";
import type { CloudDb } from "../db";
import { db as defaultDb } from "../db";
import { environments, sesTenants } from "../db/schema";
import {
  decideSuspension,
  decideTrustTier,
  type EmailTrustTier,
  formatRate,
  REPUTATION_WINDOW_DAYS,
} from "../lib/email-abuse-policy";
import type { EmailSender } from "../lib/email-sender";
import { formatNoticeWindow } from "../lib/email-suspension-notice";
import { suspendEmailSending } from "../services/email-enforcement";
import {
  blocksSending,
  readEmailSendingStatus,
} from "../services/email-sending-status";
import {
  applyTrustTier,
  countOpenFindings,
  readTrustTierStats,
} from "../services/email-trust-tiers";
import type { SesClient } from "../ses/contract";

/**
 * THE REPUTATION SWEEP (PRD 08 tasks 4 and 7).
 *
 * SES's reputation policies do the auto-pausing for `established` and `watched`
 * tenants, which is why nothing here rebuilds bounce-rate maths for them. This
 * sweep exists for the two things EventBridge can never tell us:
 *
 *  1. **PROMOTION.** Nothing in AWS knows what our `established` criteria are,
 *     so a tenant that has earned `Standard` will sit on `None` forever unless
 *     something walks the fleet and checks.
 *  2. **The `new` tier's blind spot.** A `new` tenant is on reputation policy
 *     `NONE` — observation, per AWS's own onboarding guidance — so SES will
 *     never auto-pause it however badly it sends. Its daily cap bounds the rate
 *     of the damage and nothing bounds the total. This is what stops it, at the
 *     rates AUP §5.1 publishes.
 *
 * Per tenant the order is: SUSPEND if the published thresholds are crossed,
 * otherwise re-evaluate the tier. A tenant being suspended is not also promoted
 * in the same tick, which would be an incoherent pair of decisions to have made
 * about one customer in one second.
 *
 * One tenant's failure never stops the sweep. A fleet walk that aborted on the
 * first AWS throttle would leave every tenant after it unexamined, and the
 * tenants most likely to throw are the ones most worth examining.
 */

/**
 * Hourly.
 *
 * A sharper cadence than the nightly billing sweep and a slacker one than the
 * ten-minute alert sweep, and both bounds are deliberate. Faster buys almost
 * nothing: SES's own reputation policy already pauses `established` and
 * `watched` tenants in seconds through EventBridge, so this is the backstop for
 * the tier SES will not act on, and a `new` tenant is capped at 500 messages a
 * day — an hour of drift is at most twenty or so messages. Slower would let a
 * bad first list run for most of a day inside that cap.
 */
export const REPUTATION_SWEEP_CRON = "0 * * * *";

export interface ReputationSweepOptions {
  db?: CloudDb;
  /** Injected in tests; the default resolves per tenancy region. */
  ses?: SesClient;
  sender?: EmailSender;
  now?: Date;
  /** How far back rates are measured. Defaults to the policy's window. */
  windowDays?: number;
}

export interface ReputationSweepResult {
  scanned: number;
  promoted: { environmentId: string; tier: EmailTrustTier }[];
  demoted: { environmentId: string; tier: EmailTrustTier }[];
  suspended: { environmentId: string; metric: string; measured: string }[];
  /** Tenants whose evaluation threw. Unrecorded, so the next tick retries. */
  failed: { environmentId: string; error: string }[];
}

export async function sweepEmailReputation(
  options: ReputationSweepOptions = {},
): Promise<ReputationSweepResult> {
  const db = options.db ?? defaultDb;
  const now = options.now ?? new Date();
  const windowDays = options.windowDays ?? REPUTATION_WINDOW_DAYS;

  const result: ReputationSweepResult = {
    scanned: 0,
    promoted: [],
    demoted: [],
    suspended: [],
    failed: [],
  };

  const tenants = await db
    .select({
      environmentId: sesTenants.environmentId,
      trustTier: sesTenants.trustTier,
      organizationId: environments.organizationId,
    })
    .from(sesTenants)
    .innerJoin(environments, eq(environments.id, sesTenants.environmentId));

  for (const tenant of tenants) {
    result.scanned += 1;
    try {
      await evaluate(tenant, { db, now, windowDays, options, result });
    } catch (error) {
      result.failed.push({
        environmentId: tenant.environmentId,
        error: error instanceof Error ? error.message : String(error),
      });
      console.error(
        `[cloud:reputation-sweep] evaluating environment ${tenant.environmentId} failed:`,
        error,
      );
    }
  }

  return result;
}

async function evaluate(
  tenant: {
    environmentId: string;
    trustTier: EmailTrustTier;
    organizationId: string;
  },
  context: {
    db: CloudDb;
    now: Date;
    windowDays: number;
    options: ReputationSweepOptions;
    result: ReputationSweepResult;
  },
): Promise<void> {
  const { db, now, windowDays, options, result } = context;

  const stats = await readTrustTierStats({
    environmentId: tenant.environmentId,
    now,
    windowDays,
    db,
  });

  const verdict = decideSuspension(stats);
  if (verdict.action === "suspend") {
    const status = await readEmailSendingStatus({
      environmentId: tenant.environmentId,
      db,
    });
    // Already stopped, by us or by AWS. Re-asserting would be one more AWS call
    // per tick to change nothing, and `suspendEmailSending` would find no
    // transition and send no notice anyway.
    if (blocksSending(status.status)) return;

    const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
    const outcome = await suspendEmailSending({
      environmentId: tenant.environmentId,
      cause: `${verdict.metric} of ${formatRate(verdict.measured)} across ${verdict.volume.toLocaleString(
        "en-GB",
      )} messages sent, against a limit of ${formatRate(verdict.threshold)}`,
      clause: verdict.clause,
      variant: "automatic",
      measurement: {
        metric: verdict.metric,
        measured: verdict.measured,
        threshold: verdict.threshold,
        volume: verdict.volume,
        window: formatNoticeWindow(since, now),
      },
      source: "operator",
      at: now,
      db,
      ...(options.ses ? { ses: options.ses } : {}),
      ...(options.sender ? { sender: options.sender } : {}),
    });
    if (outcome.suspended) {
      result.suspended.push({
        environmentId: tenant.environmentId,
        metric: verdict.metric,
        measured: formatRate(verdict.measured),
      });
    }
    return;
  }

  const openFindings = await countOpenFindings({
    environmentId: tenant.environmentId,
    db,
  });
  const decision = decideTrustTier({
    tier: tenant.trustTier,
    stats,
    openFindings,
  });
  if (!decision.changed) return;

  const applied = await applyTrustTier({
    environmentId: tenant.environmentId,
    tier: decision.tier,
    reason: decision.reason,
    db,
    ...(options.ses ? { ses: options.ses } : {}),
  });
  if (!applied.changed) return;

  const entry = { environmentId: tenant.environmentId, tier: applied.tier };
  if (applied.tier === "watched") result.demoted.push(entry);
  else result.promoted.push(entry);
}
