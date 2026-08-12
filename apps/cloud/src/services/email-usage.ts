import { and, count, eq, gte, inArray, sql, sum } from "drizzle-orm";
import type { CloudDb } from "../db";
import { db as defaultDb } from "../db";
import { emailDailySends, organizations, usageCounters } from "../db/schema";
import {
  type AllowanceCommit,
  type AllowanceGate,
  type AllowanceRequest,
  type AllowanceVerdict,
  decideAllowance,
} from "../lib/email-allowance";
import type { CloudPlan } from "./orgs";
import { planLimits } from "./plan-limits";
import { billingWindow, usageMonth, usagePeriod } from "./usage";

/**
 * The Hogsend Email meter: the SOURCE `usage_counters` was scaffolded for, and
 * the gate the relay asks before every send (PRD 09).
 *
 * Four rules, each of which is a bug if it is broken:
 *
 *  - **Count AFTER the wire accepted the message.** A message counted and then
 *    not sent bills a customer for nothing, and the relay's ordering already
 *    puts the CHECK before the wire and the commit after it.
 *  - **Increment by UPSERT, never read-then-write.** `usage_counters` carries a
 *    unique index on `(environment_id, month)` precisely so concurrent metering
 *    writes cannot lose a count. A read-modify-write passes every sequential
 *    test and silently undercounts under load, which is a revenue bug that
 *    never surfaces as an error.
 *  - **The allowance is the ORGANIZATION's, not the environment's.** The plan
 *    is bought once and `usage_counters` is per environment, so the gate sums.
 *    A per-environment cap would be a bypass one `hogsend env create` wide.
 *  - **Its own column.** See `db/schema/usage-counters.ts` — `emails_count` has
 *    an absolute writer already, and it counts a different population.
 */

export interface RecordRelayEmailsInput {
  organizationId: string;
  environmentId: string;
  /** Messages the wire ACCEPTED. Never the number submitted. */
  count: number;
  /** The instant they were sent; picks the `YYYY-MM` row. */
  at?: Date;
}

/**
 * Add `count` to one environment's month. One statement, no read.
 *
 * A zero or negative count writes nothing at all rather than creating an empty
 * row: a batch where every item failed is not a period with usage in it, and
 * the reporting sweep walks rows.
 */
export async function recordRelayEmails(
  input: RecordRelayEmailsInput,
  database: CloudDb = defaultDb,
): Promise<void> {
  if (!Number.isFinite(input.count) || input.count <= 0) return;
  const at = input.at ?? new Date();

  await database
    .insert(usageCounters)
    .values({
      organizationId: input.organizationId,
      environmentId: input.environmentId,
      month: usageMonth(at),
      relayEmailsCount: input.count,
    })
    .onConflictDoUpdate({
      target: [usageCounters.environmentId, usageCounters.month],
      set: {
        // Read INSIDE the statement, so two concurrent sends serialize on the
        // row rather than on a value either of them read a moment ago.
        relayEmailsCount: sql`${usageCounters.relayEmailsCount} + ${input.count}`,
        updatedAt: at,
      },
    });

  // THE SAME sends, counted by day, for the `new` tier's daily cap (PRD 08).
  // Written from here rather than from the relay so the two counters can never
  // describe different populations — a cap judged against a number the billing
  // meter disagrees with would be indefensible in an appeal.
  await database
    .insert(emailDailySends)
    .values({
      environmentId: input.environmentId,
      day: usageDay(at),
      count: input.count,
    })
    .onConflictDoUpdate({
      target: [emailDailySends.environmentId, emailDailySends.day],
      set: {
        count: sql`${emailDailySends.count} + ${input.count}`,
        updatedAt: at,
      },
    });
}

/** The UTC calendar day, `YYYY-MM-DD` — the daily counter's arbiter. */
export function usageDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** Relay sends for one environment on one UTC day. The `new` tier's number. */
export async function readRelayEmailsForDay(
  input: { environmentId: string; at: Date },
  database: CloudDb = defaultDb,
): Promise<number> {
  const [row] = await database
    .select({ count: emailDailySends.count })
    .from(emailDailySends)
    .where(
      and(
        eq(emailDailySends.environmentId, input.environmentId),
        eq(emailDailySends.day, usageDay(input.at)),
      ),
    )
    .limit(1);
  return row?.count ?? 0;
}

/**
 * How many distinct UTC days this environment has sent on since `since`, and
 * how many messages in total — the volume-and-window half of the `established`
 * criteria, in one query.
 *
 * Days on which the counter reached zero are excluded: a row written and then
 * fully refunded is not a day of sending. In practice the meter never writes a
 * zero (`recordRelayEmails` returns early), so this is a statement of the rule
 * rather than a filter that fires.
 */
export async function readRelaySendingWindow(
  input: { environmentId: string; since: Date },
  database: CloudDb = defaultDb,
): Promise<{ sendingDays: number; sent: number }> {
  const [row] = await database
    .select({
      sendingDays: count(emailDailySends.id),
      sent: sum(emailDailySends.count),
    })
    .from(emailDailySends)
    .where(
      and(
        eq(emailDailySends.environmentId, input.environmentId),
        gte(emailDailySends.day, usageDay(input.since)),
        sql`${emailDailySends.count} > 0`,
      ),
    );
  return {
    sendingDays: Number(row?.sendingDays ?? 0),
    sent: Number(row?.sent ?? 0),
  };
}

/** Relay sends for one organization over the named months. */
async function sumRelayEmails(
  database: CloudDb,
  organizationId: string,
  months: string[],
): Promise<number> {
  if (months.length === 0) return 0;
  const [row] = await database
    .select({ used: sum(usageCounters.relayEmailsCount) })
    .from(usageCounters)
    .where(
      and(
        eq(usageCounters.organizationId, organizationId),
        inArray(usageCounters.month, months),
      ),
    );
  return Number(row?.used ?? 0);
}

/**
 * Relay sends for one organization over its BILLING WINDOW.
 *
 * The window rather than the month, because a trial's allowance is a total for
 * the whole 14 days (DECISIONS §2) and `billingWindow` already owns that rule.
 * Reusing it is what stops a trial that starts on the 20th being handed a
 * second free allowance on the 1st. This is the number the gate enforces and
 * the number a warning is a percentage OF; they must be the same one.
 */
export async function readRelayEmailsInWindow(
  organization: { id: string; plan: CloudPlan; createdAt: Date },
  now: Date,
  database: CloudDb = defaultDb,
): Promise<number> {
  return sumRelayEmails(
    database,
    organization.id,
    billingWindow(organization, now).months,
  );
}

/** Relay sends for one organization in exactly one `YYYY-MM`. The number an
 * invoice is drawn from, so it is a calendar month and nothing else. */
export async function readRelayEmailsForPeriod(
  input: { organizationId: string; period: string },
  database: CloudDb = defaultDb,
): Promise<number> {
  return sumRelayEmails(database, input.organizationId, [input.period]);
}

export interface EmailAllowanceGateDeps {
  db?: CloudDb;
  /** Injected so a test can pin the period. */
  now?: () => Date;
}

/**
 * The real gate: `usage_counters` in, `decideAllowance` out.
 *
 * Fails CLOSED on an organization it cannot read. That state is unreachable
 * through the relay — `resolveRelayCaller` inner-joins the organization before
 * this is called — so reaching it means the row vanished mid-request, and
 * sending on behalf of a tenant that no longer exists is the worse of the two
 * ways to be wrong.
 */
export function createEmailAllowanceGate(
  deps: EmailAllowanceGateDeps = {},
): AllowanceGate {
  const database = deps.db ?? defaultDb;
  const clock = deps.now ?? (() => new Date());

  return {
    async canSend(request: AllowanceRequest): Promise<AllowanceVerdict> {
      const now = clock();
      const [organization] = await database
        .select({
          plan: organizations.plan,
          createdAt: organizations.createdAt,
        })
        .from(organizations)
        .where(eq(organizations.id, request.organizationId))
        .limit(1);

      if (!organization) {
        return {
          allowed: false,
          reason: "allowance_exhausted",
          limit: 0,
          used: 0,
        };
      }

      const limits = planLimits(organization.plan as CloudPlan);
      const used = await readRelayEmailsInWindow(
        { ...organization, id: request.organizationId },
        now,
        database,
      );

      const resets = resetsAt(organization.plan as CloudPlan, now);
      return decideAllowance({
        limit: limits.emailsPerMonth,
        used,
        count: request.count,
        overageEnabled: limits.emailOverage,
        hardCap: limits.emailHardCap,
        ...(resets ? { resetsAt: resets } : {}),
      });
    },

    async recordSent(commit: AllowanceCommit): Promise<void> {
      await recordRelayEmails(
        {
          organizationId: commit.organizationId,
          environmentId: commit.environmentId,
          count: commit.count,
          at: commit.at ?? clock(),
        },
        database,
      );
    },
  };
}

/**
 * When the allowance comes back.
 *
 * A paid plan's period is the calendar month, so it resets at the next one. A
 * TRIAL's allowance is a total for the whole trial and never resets, so the
 * field is omitted rather than filled with a date that would be a lie.
 */
function resetsAt(plan: CloudPlan, now: Date): string | undefined {
  if (plan === "trial") return undefined;
  return usagePeriod(now).until.toISOString();
}
