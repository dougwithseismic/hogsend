import { and, eq, isNotNull, sql } from "drizzle-orm";
import { getBilling } from "../billing";
import type { BillingProvider, UsageMeter } from "../billing/types";
import { BillingDisabledError } from "../billing/types";
import type { CloudDb } from "../db";
import { db as defaultDb } from "../db";
import {
  emailAllowanceWarnings,
  emailOverageReports,
  member,
  organizations,
  user,
} from "../db/schema";
import type { EmailSender } from "../lib/email-sender";
import { resolveEmailSender } from "../lib/email-sender";
import { hasRole } from "../lib/org-members";
import { writeAudit } from "../services/audit";
import {
  readRelayEmailsForPeriod,
  readRelayEmailsInWindow,
} from "../services/email-usage";
import type { CloudPlan, OrganizationRow } from "../services/orgs";
import {
  EMAIL_ALLOWANCE_WARNING_PERCENTS,
  planLimits,
} from "../services/plan-limits";
import { sweepPeriods, usageMonth, usagePeriod } from "../services/usage";
import { METERING_ACTOR, reasonOf } from "./enforcement";

/**
 * Hogsend Email overage: what gets billed, what gets said first, and how both
 * survive being run twice (PRD 09).
 *
 * The laws, in the order they matter:
 *
 *  - **Nothing here may double-bill.** A duplicated usage record is a customer
 *    complaint and a refund; it is the worst outcome available in this file. So
 *    every report goes through a two-phase ledger (claim → wire → commit) whose
 *    claim PINS a deterministic idempotency key, and the provider deduplicates
 *    on that key. A crash anywhere in the sequence costs at most a repeat of a
 *    call the provider already knows about.
 *  - **A dropped usage record is silent lost revenue**, so the ledger is
 *    committed AFTER the wire, never before. Reversing the two would turn a
 *    failed call into money nobody ever invoices.
 *  - **Report the DELTA, never the total.** Usage meters aggregate by sum. The
 *    counter is monotonic within a month, so `counted - reported` is always the
 *    honest increment, and it is also the whole of reconciliation: a run that
 *    finds a gap simply reports it.
 *  - **Warn before blocking.** Crossing a cap must never be the first a tenant
 *    hears about it, and a warning that repeats every night teaches them to
 *    filter the channel — so the notice is recorded per threshold per period.
 *  - **One dead tenant never stops the fleet.** Every per-organization step is
 *    wrapped, recorded, and stepped over, exactly like the metering sweep.
 */

export const EMAIL_OVERAGE_METER: UsageMeter = "email_overage";

export const OVERAGE_REPORTED_ACTION = "usage.email_overage_reported";
export const OVERAGE_RECONCILED_ACTION = "usage.email_overage_reconciled";
export const OVERAGE_DRIFT_ACTION = "usage.email_overage_drift";
export const OVERAGE_FAILED_ACTION = "usage.email_overage_failed";
export const ALLOWANCE_WARNED_ACTION = "usage.email_allowance_warned";

export interface OverageDeps {
  db: CloudDb;
  /** Injected in tests; resolved from `CLOUD_BILLING` in production. */
  billing: BillingProvider | null;
  sender: EmailSender;
  now: () => Date;
}

function resolve(overrides: Partial<OverageDeps> = {}): OverageDeps {
  return {
    db: overrides.db ?? defaultDb,
    // Resolved per RUN rather than at import: a control plane running with
    // `CLOUD_BILLING=disabled` has no provider at all, and that is a supported
    // configuration rather than a crash — there is simply nothing to bill.
    // Keyed on presence, not on truthiness, so a test can inject `null` — and
    // so an explicit `undefined` cannot silently un-resolve the provider.
    billing:
      "billing" in overrides ? (overrides.billing ?? null) : billingOrNull(),
    sender: overrides.sender ?? resolveEmailSender(),
    now: overrides.now ?? (() => new Date()),
  };
}

function billingOrNull(): BillingProvider | null {
  try {
    return getBilling();
  } catch (error) {
    if (error instanceof BillingDisabledError) return null;
    throw error;
  }
}

/** The period a run bills: the current UTC calendar month. */
function periodOf(now: Date): string {
  return usageMonth(now);
}

export interface OrganizationOverage {
  organizationId: string;
  period: string;
  /** The plan's included messages for the period. */
  allowance: number;
  /** Relay sends counted in the period. */
  used: number;
  /** `used - allowance`, floored at zero. */
  overage: number;
  /** What the ledger says was already billed. */
  previouslyReported: number;
  /** What this run sent to the provider. Zero when there was nothing to add. */
  delta: number;
  reported: boolean;
  /** The provider recognised the key and did not bill again. */
  deduplicated: boolean;
}

export interface OverageFailure {
  organizationId: string;
  reason: string;
}

export interface ReportOverageResult {
  period: string;
  reports: OrganizationOverage[];
  failed: OverageFailure[];
}

/**
 * Bill every organization that went over its included allowance.
 *
 * Bills the CURRENT period and, while a month boundary is still fresh, the
 * PREVIOUS one too — the same closing window the usage meter uses
 * (`sweepPeriods`). Without it, an overage recorded in the tail of month M —
 * after M's last nightly run — is counted in `usage_counters` but never
 * reported to the provider, because the run early in M+1 would only ever look
 * at M+1. Current period first, so a failure closing the previous month cannot
 * starve the current one.
 *
 * Safe to run as often as you like: the ledger makes a second run a no-op, and
 * a run that finds new usage bills only the new usage. Each `OrganizationOverage`
 * carries its own `period`, so the caller can tell the two months apart.
 */
export async function reportEmailOverage(
  overrides: Partial<OverageDeps> = {},
): Promise<ReportOverageResult> {
  const deps = resolve(overrides);
  const periods = sweepPeriods(deps.now());
  const reports: OrganizationOverage[] = [];
  const failed: OverageFailure[] = [];

  const organizationsList = await allOrganizations(deps.db);
  for (const { month: period } of periods) {
    for (const organization of organizationsList) {
      try {
        const report = await reportOne(deps, organization, period);
        if (report) reports.push(report);
      } catch (error) {
        failed.push(await recordFailure(deps, organization.id, period, error));
      }
    }
  }

  return { period: periodOf(deps.now()), reports, failed };
}

export interface ReconcileOverageResult {
  period: string;
  /** Gaps found and closed: usage that was counted but never billed. */
  repaired: OrganizationOverage[];
  /** Reported MORE than was counted. Recorded, never un-billed. */
  drifted: { organizationId: string; reported: number; counted: number }[];
  failed: OverageFailure[];
}

/**
 * Compare what has been reported against what has been counted, and repair the
 * difference.
 *
 * A separate pass from `reportEmailOverage` because it answers a different
 * question. Reporting walks tenants and asks "is there anything new to bill?";
 * this walks the LEDGER and asks "does what we billed still match what we
 * counted?" — which is the only way a usage record dropped by a failure nobody
 * saw is ever noticed. Both directions are recorded; only the under-reported
 * one can be fixed, because a meter event cannot be withdrawn.
 */
export async function reconcileEmailOverage(
  overrides: Partial<OverageDeps> = {},
): Promise<ReconcileOverageResult> {
  const deps = resolve(overrides);
  const periods = sweepPeriods(deps.now());
  const repaired: OrganizationOverage[] = [];
  const drifted: ReconcileOverageResult["drifted"] = [];
  const failed: OverageFailure[] = [];

  // The same closing window `reportEmailOverage` uses: the ledger for the tail
  // of month M is only written by the run early in M+1, so reconciling M+1
  // alone would never notice a usage record dropped in M.
  for (const { month: period } of periods) {
    const ledger = await deps.db
      .select()
      .from(emailOverageReports)
      .where(eq(emailOverageReports.period, period));

    for (const row of ledger) {
      const [organization] = await deps.db
        .select()
        .from(organizations)
        .where(eq(organizations.id, row.organizationId))
        .limit(1);
      if (!organization) continue;

      try {
        const counted = await countedOverage(deps, organization, period);
        const settled = row.reportedQuantity;

        if (counted > settled || row.pendingQuantity !== null) {
          const report = await reportOne(deps, organization, period);
          if (report?.reported) {
            repaired.push(report);
            await writeAudit(deps.db, {
              actor: METERING_ACTOR,
              organizationId: organization.id,
              action: OVERAGE_RECONCILED_ACTION,
              subject: organization.id,
              detail: {
                period,
                wasReported: settled,
                counted,
                delta: report.delta,
              },
            });
          }
          continue;
        }

        if (counted < settled) {
          drifted.push({
            organizationId: organization.id,
            reported: settled,
            counted,
          });
          // Nothing to send: a meter event cannot be taken back, and inventing
          // a negative quantity would be a credit nobody authorised. The row is
          // the record an operator (and a refund) can act on.
          await writeAudit(deps.db, {
            actor: METERING_ACTOR,
            organizationId: organization.id,
            action: OVERAGE_DRIFT_ACTION,
            subject: organization.id,
            detail: { period, reported: settled, counted },
          });
        }
      } catch (error) {
        failed.push(
          await recordFailure(deps, row.organizationId, period, error),
        );
      }
    }
  }

  return { period: periodOf(deps.now()), repaired, drifted, failed };
}

// ---------------------------------------------------------------------------
// One organization
// ---------------------------------------------------------------------------

/**
 * Every organization, including suspended ones.
 *
 * Deliberately unfiltered: usage a tenant ran up before they were stopped is
 * still usage they owe for, and a suspended stack sends nothing new anyway, so
 * filtering here would drop the last period of a churned customer's bill.
 */
async function allOrganizations(db: CloudDb): Promise<OrganizationRow[]> {
  return db.select().from(organizations);
}

/** Overage as the COUNTER sees it, right now. */
async function countedOverage(
  deps: OverageDeps,
  organization: OrganizationRow,
  period: string,
): Promise<number> {
  const limits = planLimits(organization.plan as CloudPlan);
  const used = await readRelayEmailsForPeriod(
    { organizationId: organization.id, period },
    deps.db,
  );
  return Math.max(0, used - limits.emailsPerMonth);
}

/**
 * Claim → report → commit, for one organization and one period.
 *
 * Returns null for a plan that does not bill overage at all; every other plan
 * gets a row in the result even when there is nothing to report, so a caller
 * can see that it was judged.
 */
async function reportOne(
  deps: OverageDeps,
  organization: OrganizationRow,
  period: string,
): Promise<OrganizationOverage | null> {
  const limits = planLimits(organization.plan as CloudPlan);
  // A plan with no overage never bills above its allowance — the hard cap has
  // already stopped the sending, and a trial has no card on file to charge.
  if (!limits.emailOverage) return null;

  const used = await readRelayEmailsForPeriod(
    { organizationId: organization.id, period },
    deps.db,
  );
  const overage = Math.max(0, used - limits.emailsPerMonth);

  const settled = await readLedger(deps.db, organization.id, period);
  const alreadyReported = settled?.reportedQuantity ?? 0;

  // Nothing new and nothing in flight: the common case on a steady tenant, and
  // it writes NOTHING. A claim taken here would be a pair of pointless updates
  // per organization per night.
  if (overage <= alreadyReported && settled?.pendingQuantity == null) {
    return {
      organizationId: organization.id,
      period,
      allowance: limits.emailsPerMonth,
      used,
      overage,
      previouslyReported: alreadyReported,
      delta: 0,
      reported: false,
      deduplicated: false,
    };
  }

  const claim = await claimReport(deps.db, {
    organizationId: organization.id,
    period,
    quantity: overage,
    now: deps.now(),
  });
  const delta = claim.pending - claim.reported;

  if (delta <= 0) {
    // A claim for a total that is already settled — an interrupted run whose
    // report did land. Clear it, or it would pin the idempotency key forever
    // and no later growth in usage could ever be billed.
    await commitReport(deps.db, organization.id, period, claim.reported);
    return {
      organizationId: organization.id,
      period,
      allowance: limits.emailsPerMonth,
      used,
      overage,
      previouslyReported: claim.reported,
      delta: 0,
      reported: false,
      deduplicated: false,
    };
  }

  if (!deps.billing) {
    // `CLOUD_BILLING=disabled`. The claim stays, so a deploy that later wires
    // billing bills this period rather than losing it.
    throw new BillingDisabledError();
  }

  const result = await deps.billing.reportUsage({
    organizationId: organization.id,
    meter: EMAIL_OVERAGE_METER,
    quantity: delta,
    period,
    // DETERMINISTIC in the claimed cumulative total, which is why the claim is
    // sticky: a retry of an attempt whose outcome we never learned presents
    // this exact string again and the provider refuses to bill it twice.
    idempotencyKey: overageIdempotencyKey(
      organization.id,
      period,
      claim.pending,
    ),
    occurredAt: deps.now(),
  });

  // Only NOW, and only because the wire answered.
  await commitReport(
    deps.db,
    organization.id,
    period,
    claim.pending,
    deps.now(),
  );
  await writeAudit(deps.db, {
    actor: METERING_ACTOR,
    organizationId: organization.id,
    action: OVERAGE_REPORTED_ACTION,
    subject: organization.id,
    detail: {
      period,
      used,
      allowance: limits.emailsPerMonth,
      overage: claim.pending,
      delta,
      deduplicated: result.deduplicated,
    },
  });

  return {
    organizationId: organization.id,
    period,
    allowance: limits.emailsPerMonth,
    used,
    overage,
    previouslyReported: claim.reported,
    delta,
    reported: true,
    deduplicated: result.deduplicated,
  };
}

/** The key the provider deduplicates on. Content-derived, never positional. */
export function overageIdempotencyKey(
  organizationId: string,
  period: string,
  cumulative: number,
): string {
  return `email-overage:${organizationId}:${period}:${cumulative}`;
}

async function readLedger(
  db: CloudDb,
  organizationId: string,
  period: string,
): Promise<{
  reportedQuantity: number;
  pendingQuantity: number | null;
} | null> {
  const [row] = await db
    .select({
      reportedQuantity: emailOverageReports.reportedQuantity,
      pendingQuantity: emailOverageReports.pendingQuantity,
    })
    .from(emailOverageReports)
    .where(
      and(
        eq(emailOverageReports.organizationId, organizationId),
        eq(emailOverageReports.period, period),
      ),
    );
  return row ?? null;
}

/**
 * Take (or inherit) the claim for this period.
 *
 * `COALESCE(existing.pending, new)` is the sticky half: an unsettled claim is
 * NEVER raised by a later run. If it were, a retry after a lost response would
 * present a different idempotency key for overlapping usage, and the provider
 * would bill the overlap twice — which is precisely the failure this whole
 * dance exists to prevent. Growth beyond a stuck claim is picked up on the run
 * after it settles.
 */
async function claimReport(
  db: CloudDb,
  input: {
    organizationId: string;
    period: string;
    quantity: number;
    now: Date;
  },
): Promise<{ reported: number; pending: number }> {
  const [row] = await db
    .insert(emailOverageReports)
    .values({
      organizationId: input.organizationId,
      period: input.period,
      reportedQuantity: 0,
      pendingQuantity: input.quantity,
    })
    .onConflictDoUpdate({
      target: [emailOverageReports.organizationId, emailOverageReports.period],
      set: {
        pendingQuantity: sql`coalesce(${emailOverageReports.pendingQuantity}, ${input.quantity})`,
        updatedAt: input.now,
      },
    })
    .returning({
      reported: emailOverageReports.reportedQuantity,
      pending: emailOverageReports.pendingQuantity,
    });

  if (!row) throw new Error("overage claim wrote no row");
  return { reported: row.reported, pending: row.pending ?? row.reported };
}

/** Settle the claim. The only writer of `reported_quantity`. */
async function commitReport(
  db: CloudDb,
  organizationId: string,
  period: string,
  quantity: number,
  now?: Date,
): Promise<void> {
  await db
    .update(emailOverageReports)
    .set({
      reportedQuantity: quantity,
      pendingQuantity: null,
      ...(now ? { lastReportedAt: now, updatedAt: now } : {}),
    })
    .where(
      and(
        eq(emailOverageReports.organizationId, organizationId),
        eq(emailOverageReports.period, period),
      ),
    );
}

async function recordFailure(
  deps: OverageDeps,
  organizationId: string,
  period: string,
  error: unknown,
): Promise<OverageFailure> {
  const reason = reasonOf(error);
  // Recorded against the tenant, because an unbilled period is a fact about
  // THEIR invoice and an operator has to be able to find it later.
  await writeAudit(deps.db, {
    actor: METERING_ACTOR,
    organizationId,
    action: OVERAGE_FAILED_ACTION,
    subject: organizationId,
    detail: { period, reason },
  }).catch(() => undefined);
  return { organizationId, reason };
}

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

export interface AllowanceNotice {
  organizationId: string;
  percent: number;
  used: number;
  allowance: number;
  recipients: number;
}

export interface WarnAllowanceResult {
  period: string;
  notices: AllowanceNotice[];
  /** Thresholds that were crossed and had already been sent. The quiet is
   * measurable. */
  suppressed: number;
  failed: OverageFailure[];
}

/**
 * Tell an organization it is approaching its email allowance, once per
 * threshold per period.
 */
export async function warnEmailAllowance(
  overrides: Partial<OverageDeps> = {},
): Promise<WarnAllowanceResult> {
  const deps = resolve(overrides);
  const now = deps.now();
  const period = periodOf(now);
  const notices: AllowanceNotice[] = [];
  const failed: OverageFailure[] = [];
  let suppressed = 0;

  for (const organization of await allOrganizations(deps.db)) {
    try {
      const limits = planLimits(organization.plan as CloudPlan);
      // The WINDOW, deliberately: a warning is a percentage of the allowance
      // the gate actually enforces, and on a trial that allowance spans every
      // month the trial has touched. Measuring a calendar month here would tell
      // a trial they are at 40% while the gate refuses them.
      const used = await readRelayEmailsInWindow(organization, now, deps.db);
      if (used === 0) continue;

      for (const percent of EMAIL_ALLOWANCE_WARNING_PERCENTS) {
        if (used * 100 < limits.emailsPerMonth * percent) continue;

        const recipients = await organizationOwnerEmails(
          deps.db,
          organization.id,
        );
        // Nobody to tell. Recording it anyway would burn the one notice this
        // threshold gets on an address that does not exist.
        if (recipients.length === 0) continue;

        // THE lock: the insert is the claim. Two sweeps running at once cannot
        // both come back with a row, so the notice cannot go out twice.
        const [claimed] = await deps.db
          .insert(emailAllowanceWarnings)
          .values({
            organizationId: organization.id,
            period,
            percent,
            used,
            allowance: limits.emailsPerMonth,
            recipients: recipients.length,
          })
          .onConflictDoNothing()
          .returning({ id: emailAllowanceWarnings.id });
        if (!claimed) {
          suppressed += 1;
          continue;
        }

        for (const to of recipients) {
          await deps.sender.send({
            to,
            subject: allowanceWarningSubject(percent),
            text: allowanceWarningBody({
              percent,
              used,
              limits,
              plan: organization.plan as CloudPlan,
              now,
            }),
          });
        }

        await writeAudit(deps.db, {
          actor: METERING_ACTOR,
          organizationId: organization.id,
          action: ALLOWANCE_WARNED_ACTION,
          subject: organization.id,
          detail: {
            period,
            percent,
            used,
            allowance: limits.emailsPerMonth,
            recipients: recipients.length,
          },
        });

        notices.push({
          organizationId: organization.id,
          percent,
          used,
          allowance: limits.emailsPerMonth,
          recipients: recipients.length,
        });
      }
    } catch (error) {
      failed.push(await recordFailure(deps, organization.id, period, error));
    }
  }

  return { period, notices, suppressed, failed };
}

/** Every owner of the organization, oldest membership first. */
async function organizationOwnerEmails(
  db: CloudDb,
  organizationId: string,
): Promise<string[]> {
  const rows = await db
    .select({ role: member.role, email: user.email })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(
      and(eq(member.organizationId, organizationId), isNotNull(user.email)),
    )
    .orderBy(member.createdAt);
  // The role column is a comma-separated list ("owner,admin" is legal), so it
  // is split rather than compared.
  return rows.filter((row) => hasRole(row.role, "owner")).map((r) => r.email);
}

function allowanceWarningSubject(percent: number): string {
  return percent >= 100
    ? "You have used 100% of this period's email allowance"
    : `You have used ${percent}% of this period's email allowance`;
}

function allowanceWarningBody(input: {
  percent: number;
  used: number;
  limits: {
    emailsPerMonth: number;
    emailOverage: boolean;
    emailHardCap: number;
  };
  plan: CloudPlan;
  now: Date;
}): string {
  const lines = [
    `Your organization has sent ${input.used} of the ${input.limits.emailsPerMonth} emails included in the ${input.plan} plan this billing period.`,
    "",
    input.limits.emailOverage
      ? `Messages above the included allowance are billed as metered overage. Sending stops at ${input.limits.emailHardCap} messages in a period.`
      : "Sending stops when the included allowance is used up. Upgrade the plan to keep sending.",
  ];
  if (input.plan !== "trial") {
    lines.push(
      "",
      `The allowance resets on ${usagePeriod(input.now).until.toISOString().slice(0, 10)}.`,
    );
  }
  return lines.join("\n");
}
