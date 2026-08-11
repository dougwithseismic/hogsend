import { desc, eq } from "drizzle-orm";
import type { CloudDb } from "../db";
import { db as defaultDb } from "../db";
import { emailPauseHistory, organizations, sesTenants } from "../db/schema";
import {
  type EmailFindingRecord,
  listOpenEmailFindings,
} from "../services/email-findings";
import {
  type EmailSendingStatusValue,
  readEmailSendingStatus,
} from "../services/email-sending-status";
import {
  readRelayEmailsForDay,
  readRelayEmailsInWindow,
} from "../services/email-usage";
import type { CloudPlan } from "../services/orgs";
import { planLimits } from "../services/plan-limits";
import {
  allowsBulkImport,
  type EmailTrustTier,
  type TierSendCap,
  tierSendCap,
} from "./email-abuse-policy";

/**
 * THE OPERATOR VIEW (PRD 08 task 8) — everything about one tenant's sending
 * standing, in one read.
 *
 * **OBSERVE-ONLY, and that is a product decision rather than a scope cut.**
 * There is no unpause button here and there is no route that could grow one:
 * appeals are a human queue (AUP §6.6), reinstatement is never granted on
 * request alone, and a button is an automatic bypass wearing a UI. The lever
 * exists — `reinstateEmailSending` in `services/email-enforcement.ts` — and it
 * is a function an operator calls with their name recorded against it.
 *
 * Nothing here writes. Every number is read from the same row the enforcement
 * path wrote, so the page cannot show a cap the relay is not enforcing.
 */

export interface EmailPauseHistoryEntry {
  id: string;
  status: EmailSendingStatusValue;
  reason: string | null;
  source: string;
  at: Date;
}

export interface EmailSendingView {
  /** Whether this environment may send right now, and why not. */
  status: EmailSendingStatusValue;
  reason: string | null;
  pausedAt: Date | null;
  tier: EmailTrustTier;
  /** Null on `established`: the plan allowance is the only ceiling there. */
  cap: TierSendCap | null;
  /** Messages sent in the cap's own window — the number the cap is judged on. */
  usedInCapWindow: number;
  bulkImportAllowed: boolean;
  openFindings: EmailFindingRecord[];
  pauseHistory: EmailPauseHistoryEntry[];
}

/** How many transitions the panel shows. Enough to see a repeat breach. */
export const PAUSE_HISTORY_LENGTH = 10;

/**
 * One environment's sending standing, or null when it has no Hogsend Email
 * tenancy at all.
 *
 * Null rather than a view full of defaults: an environment on its own Resend
 * key has no trust tier, no cap and no findings, and showing it "new / 500 a
 * day" would describe an enforcement that does not apply to it.
 */
export async function readEmailSendingView(input: {
  environmentId: string;
  organizationId: string;
  now?: Date;
  db?: CloudDb;
}): Promise<EmailSendingView | null> {
  const db = input.db ?? defaultDb;
  const now = input.now ?? new Date();

  const [tenancy] = await db
    .select({ trustTier: sesTenants.trustTier })
    .from(sesTenants)
    .where(eq(sesTenants.environmentId, input.environmentId))
    .limit(1);
  if (!tenancy) return null;

  const [organization] = await db
    .select({ plan: organizations.plan, createdAt: organizations.createdAt })
    .from(organizations)
    .where(eq(organizations.id, input.organizationId))
    .limit(1);
  const plan = (organization?.plan ?? "trial") as CloudPlan;

  const tier = tenancy.trustTier;
  const cap = tierSendCap({
    tier,
    planAllowance: planLimits(plan).emailsPerMonth,
  });

  const [status, openFindings, history, used] = await Promise.all([
    readEmailSendingStatus({ environmentId: input.environmentId, db }),
    listOpenEmailFindings({ environmentId: input.environmentId, db }),
    db
      .select({
        id: emailPauseHistory.id,
        status: emailPauseHistory.status,
        reason: emailPauseHistory.reason,
        source: emailPauseHistory.source,
        at: emailPauseHistory.at,
      })
      .from(emailPauseHistory)
      .where(eq(emailPauseHistory.environmentId, input.environmentId))
      .orderBy(desc(emailPauseHistory.at), desc(emailPauseHistory.id))
      .limit(PAUSE_HISTORY_LENGTH),
    capUsage({
      cap,
      environmentId: input.environmentId,
      organizationId: input.organizationId,
      plan,
      createdAt: organization?.createdAt ?? now,
      now,
      db,
    }),
  ]);

  return {
    status: status.status,
    reason: status.reason,
    pausedAt: status.pausedAt,
    tier,
    cap,
    usedInCapWindow: used,
    bulkImportAllowed: allowsBulkImport(tier),
    openFindings,
    pauseHistory: history,
  };
}

/**
 * Usage measured in the CAP's window, not in a window of the page's choosing.
 *
 * A daily cap shown beside a monthly number would read as wildly under-used
 * right up to the moment it refused a send.
 */
async function capUsage(input: {
  cap: TierSendCap | null;
  environmentId: string;
  organizationId: string;
  plan: CloudPlan;
  createdAt: Date;
  now: Date;
  db: CloudDb;
}): Promise<number> {
  if (!input.cap) return 0;
  if (input.cap.window === "day") {
    return readRelayEmailsForDay(
      { environmentId: input.environmentId, at: input.now },
      input.db,
    );
  }
  return readRelayEmailsInWindow(
    {
      id: input.organizationId,
      plan: input.plan,
      createdAt: input.createdAt,
    },
    input.now,
    input.db,
  );
}
