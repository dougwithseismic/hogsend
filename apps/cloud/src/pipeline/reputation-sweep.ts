import { desc, eq } from "drizzle-orm";
import type { CloudDb } from "../db";
import { db as defaultDb } from "../db";
import { emailPauseHistory, environments, sesTenants } from "../db/schema";
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
  type EmailSendingStatusValue,
  readEmailSendingStatus,
  recordEmailSendingStatus,
} from "../services/email-sending-status";
import {
  applyTrustTier,
  countOpenFindings,
  readTrustTierStats,
} from "../services/email-trust-tiers";
import type { SesClient } from "../ses/contract";
import { getSesClient } from "../ses/index";
import { SesError, type SesReputationEntity } from "../ses/types";
import type { SubstrateRegion } from "../substrate/types";

/**
 * THE REPUTATION SWEEP (PRD 08 tasks 4 and 7).
 *
 * SES's reputation policies do the auto-pausing for `established` and `watched`
 * tenants, which is why nothing here rebuilds bounce-rate maths for them. This
 * sweep exists for the three things the EventBridge ingress cannot do:
 *
 *  1. **PROMOTION.** Nothing in AWS knows what our `established` criteria are,
 *     so a tenant that has earned `Standard` will sit on `None` forever unless
 *     something walks the fleet and checks.
 *  2. **The `new` tier's blind spot.** A `new` tenant is on reputation policy
 *     `NONE` — observation, per AWS's own onboarding guidance — so SES will
 *     never auto-pause it however badly it sends. Its daily cap bounds the rate
 *     of the damage and nothing bounds the total. This is what stops it, at the
 *     rates AUP §5.1 publishes.
 *  3. **RECONCILIATION of a MISSED event.** EventBridge delivers a pause once;
 *     a redeploy mid-flight, a delivery failure past its retry window, or a
 *     rule that was not there yet all end the same way — the mirror still says
 *     `active` for a tenant AWS has stopped, the relay reads the mirror, and
 *     the failure mode is fail-OPEN. `getReputationEntity` is the read-back
 *     that repairs it, and this is its only production caller.
 *
 * Per tenant the order is: RECONCILE against AWS first, then SUSPEND if the
 * published thresholds are crossed, otherwise re-evaluate the tier.
 * Reconciliation leads because everything after it reads the mirror: a tenant
 * AWS already paused must not be re-decided as our own enforcement, which would
 * mail the customer a suspension notice for a stop that was never ours. And a
 * tenant is not both suspended and promoted in the same tick, which would be an
 * incoherent pair of decisions to have made about one customer in one second.
 *
 * Reconciliation LEADS, but it does not GATE. It is a repair, not a
 * precondition: a failed read-back is recorded and the tenant's local
 * decisions still run on the mirror we already hold. The suspension check is a
 * pure database read with nothing to learn from AWS, and this sweep is the
 * only enforcement backstop a `new`-tier tenant has — an `AccessDenied` on
 * `ses:GetReputationEntity` (a verb that joined the IAM contract after the
 * policy appendix in docs/ses-production-access-request.md was drafted, so a
 * deployed policy may well not grant it) must degrade the sweep to
 * mirror-only, never switch it off.
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
  /** Mirrors that disagreed with AWS and were corrected toward it. */
  reconciled: {
    environmentId: string;
    from: EmailSendingStatusValue;
    to: EmailSendingStatusValue;
  }[];
  /**
   * Tenants whose AWS read-back failed. Their mirror is left untouched for the
   * next tick — but their LOCAL evaluation still ran, so an entry here never
   * appears in `failed` for the same error. Distinct from `failed` because the
   * two mean different things to an operator: this list says "the repair could
   * not run", that one says "nothing ran".
   */
  reconcileFailed: { environmentId: string; error: string }[];
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
    reconciled: [],
    reconcileFailed: [],
    failed: [],
  };

  const tenants = await db
    .select({
      environmentId: sesTenants.environmentId,
      trustTier: sesTenants.trustTier,
      organizationId: environments.organizationId,
      // The reconciliation read addresses AWS, so it needs what AWS is
      // addressed BY: the tenant's name, the ARN provisioning already stored
      // (so the read costs one call rather than two), and the region the
      // tenancy was minted in — never the organization's region today.
      tenantName: sesTenants.tenantName,
      tenantArn: sesTenants.tenantArn,
      region: sesTenants.region,
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

interface SweepTenant {
  environmentId: string;
  trustTier: EmailTrustTier;
  organizationId: string;
  tenantName: string;
  tenantArn: string;
  region: SubstrateRegion;
}

interface SweepContext {
  db: CloudDb;
  now: Date;
  windowDays: number;
  options: ReputationSweepOptions;
  result: ReputationSweepResult;
}

async function evaluate(
  tenant: SweepTenant,
  context: SweepContext,
): Promise<void> {
  const { db, now, windowDays, options, result } = context;

  // Its OWN catch, not the per-tenant one. An `AccessDenied` on the read-back
  // classifies as `invalid` — not retryable, so it will fail every tick — and
  // aborting here would take the suspension check down with it: a pure
  // database read that needs nothing from AWS, and the only thing standing
  // between a `new` tenant (reputation policy NONE — SES will never pause it)
  // and the rates AUP §5.1 publishes.
  try {
    await reconcile(tenant, context);
  } catch (error) {
    result.reconcileFailed.push({
      environmentId: tenant.environmentId,
      error: error instanceof Error ? error.message : String(error),
    });
    console.error(
      `[cloud:reputation-sweep] reconciling environment ${tenant.environmentId} failed; evaluating on the mirror we hold:`,
      error,
    );
  }

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

/**
 * Read AWS's own answer for one tenant and repair the mirror if it disagrees.
 *
 * The read is `ses:GetReputationEntity`, addressed by the ARN provisioning
 * stored — so it costs ONE call, not the getTenant-then-get pair an ARN-less
 * ref would.
 *
 * A `not_found` is SKIPPED rather than failed, and that is load-bearing: a
 * control plane with no AWS credentials still provisions (the supported
 * default), and those tenancies exist in our database and nowhere else. Failing
 * them would fill `reconcileFailed` with every tenant on such a deploy, every
 * hour, for a divergence that cannot exist. Any OTHER error propagates to the
 * caller's own catch, which records it in `reconcileFailed` and leaves the
 * mirror untouched for the next tick — never repaired on a guess about what
 * AWS would have said — while the tenant's local evaluation continues.
 */
async function reconcile(
  tenant: SweepTenant,
  context: SweepContext,
): Promise<void> {
  const { db, now, options, result } = context;
  const ses = options.ses ?? getSesClient(tenant.region);

  let entity: SesReputationEntity;
  try {
    entity = await ses.getReputationEntity({
      tenantName: tenant.tenantName,
      tenantArn: tenant.tenantArn,
    });
  } catch (error) {
    if (error instanceof SesError && error.kind === "not_found") return;
    throw error;
  }

  const mirrored = await readEmailSendingStatus({
    environmentId: tenant.environmentId,
    db,
  });
  const decision = reconcileSendingStatus(mirrored.status, entity);
  if (!decision) return;

  // The PERMISSIVE direction needs one fact the entity cannot carry. This read
  // is the TENANT's reputation entity, so its ENABLED is only authority over
  // pauses that were ABOUT the tenant — the relay also mirrors an
  // ACCOUNT-level stop as `paused`, and the tenant entity of a suspended
  // account still reads ENABLED. Clearing on that answer would un-block the
  // relay against a stop AWS never lifted and write a false "may send again"
  // line into the history an appeal is read from. The RESTRICTIVE direction
  // (recording a pause we missed) stays unconditional.
  if (
    blocksSending(mirrored.status) &&
    !blocksSending(decision.status) &&
    !(await pauseWasTenantScoped(db, tenant.environmentId))
  ) {
    console.warn(
      `[cloud:reputation-sweep] environment ${tenant.environmentId}: mirror is paused for a reason the tenant entity cannot answer for (account-scoped or unknown) — leaving it paused`,
    );
    return;
  }

  await recordEmailSendingStatus({
    environmentId: tenant.environmentId,
    status: decision.status,
    reason: decision.reason,
    at: now,
    // Not `eventbridge`: nothing was delivered to us. The pause history is read
    // by a human during an appeal, and "we found this out by asking" is a
    // different sentence from "AWS told us".
    source: "reconcile",
    db,
  });
  result.reconciled.push({
    environmentId: tenant.environmentId,
    from: mirrored.status,
    to: decision.status,
  });
  console.warn(
    `[cloud:reputation-sweep] environment ${tenant.environmentId}: mirror said ${mirrored.status}, AWS says ${entity.sendingStatus} — corrected to ${decision.status}`,
  );
}

/**
 * The sentence `pauseReason` in `lib/email-relay.ts` opens a TENANT-scoped
 * relay pause with. Duplicated (the function is private to the relay, and a
 * value export from a route module into a sweep would be a strange seam), and
 * safe to duplicate in THIS direction: if the relay ever rewords it, this
 * prefix stops matching and the gate below fails CLOSED — a tenant pause an
 * operator has to clear by hand, not an account pause silently cleared.
 */
const RELAY_TENANT_PAUSE_REASON = "SES paused this tenant";

/**
 * Was the pause the mirror is holding TENANT-scoped — i.e. is the tenant's own
 * reputation entity entitled to clear it?
 *
 * Settled by the newest pause-history row, which is the transition that put
 * the mirror where it is (the history is appended at the one choke point every
 * status write passes through, on transitions only — and nothing re-writes a
 * mirror that is already `paused`: the relay short-circuits on it pre-send,
 * and reconciliation returns null on an already-blocking mirror).
 *
 *  - `eventbridge` and `reconcile` rows are tenant-scoped by construction:
 *    both start from a signal addressed BY tenant (a Sending Status event
 *    naming its tenant; this sweep's own entity read).
 *  - a `relay` row covers both scopes, distinguished by the sentence the relay
 *    recorded — tenant stops open with `RELAY_TENANT_PAUSE_REASON`, account
 *    stops with "The sending account is suspended".
 *  - anything else — no row at all, an `operator` row, a sentence we do not
 *    recognise — is UNKNOWN scope, and unknown fails CLOSED.
 */
async function pauseWasTenantScoped(
  db: CloudDb,
  environmentId: string,
): Promise<boolean> {
  const [last] = await db
    .select({
      status: emailPauseHistory.status,
      reason: emailPauseHistory.reason,
      source: emailPauseHistory.source,
    })
    .from(emailPauseHistory)
    .where(eq(emailPauseHistory.environmentId, environmentId))
    .orderBy(desc(emailPauseHistory.at), desc(emailPauseHistory.id))
    .limit(1);

  if (!last || last.status !== "paused") return false;
  if (last.source === "eventbridge" || last.source === "reconcile") return true;
  return (
    last.source === "relay" &&
    (last.reason ?? "").startsWith(RELAY_TENANT_PAUSE_REASON)
  );
}

export interface SendingStatusReconciliation {
  status: EmailSendingStatusValue;
  reason: string;
}

/**
 * The mirror's status and AWS's entity in; the correction, or `null` when the
 * two already agree on everything that matters.
 *
 * AWS is authoritative — with ONE bounded exception of this function's own
 * (the caller holds a second: the tenant-scope gate above, which needs the
 * history and so cannot live in a pure function). Our own `enforced` stop is
 * not AWS's to reverse: `getReputationEntity` reports the customer-managed and
 * AWS-managed records separately for exactly that reason, and unblocking a
 * tenant WE suspended because AWS's own policy has nothing against them would
 * be the automatic reinstate AUP §6.6 refuses. So in the permissive direction
 * the rule is narrower than "match AWS": reconciliation ADDS a stop we missed
 * and never erases one we recorded.
 *
 * Everything else follows the fail-OPEN reasoning in
 * `docs/ses-production-access-request.md`: the dangerous disagreement is a
 * mirror that says a stopped tenant may send, and that one is always repaired.
 */
export function reconcileSendingStatus(
  mirrored: EmailSendingStatusValue,
  entity: SesReputationEntity,
): SendingStatusReconciliation | null {
  const aws = entity.sendingStatus;
  // An entity with no status is AWS declining to answer, not AWS saying
  // `active`. Moving the mirror on it would invent the fact.
  if (!aws) return null;

  if (aws === "DISABLED") {
    // Already stopped. WHICH of the two stopped it is settled by the pause
    // history and by whoever wrote it; re-deciding that here would rewrite the
    // record an appeal is read from.
    if (blocksSending(mirrored)) return null;
    const ours = entity.customerManagedStatus?.status === "DISABLED";
    return {
      status: ours ? "enforced" : "paused",
      reason: disabledCause(entity, ours),
    };
  }

  // AWS permits sending from here down.
  if (mirrored === "enforced") return null;
  if (mirrored === "paused") {
    return {
      status: "reinstated",
      reason: "SES reports this tenant may send again",
    };
  }
  if (mirrored === "active" && aws === "REINSTATED") {
    // Both permit sending, so nothing about the relay changes — but AWS
    // remembers a pause we never recorded, and the history should say so.
    return {
      status: "reinstated",
      reason: "SES reports this tenant was paused and has been reinstated",
    };
  }
  return null;
}

/** WHY, in AWS's own words where it gave any. Surfaced verbatim to the customer
 * in the relay's refusal, so it has to read as a sentence either way. */
function disabledCause(entity: SesReputationEntity, ours: boolean): string {
  const cause = ours
    ? (entity.customerManagedStatus?.cause ?? entity.awsSesManagedStatus?.cause)
    : (entity.awsSesManagedStatus?.cause ??
      entity.customerManagedStatus?.cause);
  return cause ?? "SES reports this tenant's sending as disabled";
}
