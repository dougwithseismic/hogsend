import { and, desc, eq } from "drizzle-orm";
import type { CloudDb } from "../db";
import { db as defaultDb } from "../db";
import { emailFindings } from "../db/schema";
import type { SesAbuseFinding } from "../eventbridge/events";

/**
 * SES Advisor reputation findings, mirrored per environment (PRD 08 task 3).
 *
 * Findings are the WARNING surface: they never gate a send by themselves — only
 * `email_sending_status` does that — but an open one demotes the tenant to
 * `watched`, which is what quarters its cap and blocks its imports. So the
 * count of open findings has to be exactly right in both directions: an
 * accumulating duplicate would trap a tenant in `watched` forever, and a
 * silently-overwritten one would let a real finding disappear.
 *
 * That is why the upsert arbiter is `(environment_id, type)` and not an
 * append: SES identifies a recommendation by resource and type, so the same
 * BOUNCE finding re-raised is the SAME finding, and reopening one that had been
 * fixed is a state change on one row.
 */

export interface EmailFindingRecord {
  id: string;
  type: string;
  impact: string | null;
  description: string | null;
  status: "open" | "fixed";
  openedAt: Date;
  closedAt: Date | null;
}

/**
 * Record a finding as OPEN, or reopen one that had been fixed.
 *
 * `openedAt` moves on a reopen — it answers "since when is this a problem
 * NOW", which is the question an operator triaging a `watched` tenant asks;
 * the previous episode is already in the journal.
 */
export async function openEmailFinding(input: {
  environmentId: string;
  finding: SesAbuseFinding;
  at: Date;
  db?: CloudDb;
}): Promise<void> {
  const db = input.db ?? defaultDb;
  await db
    .insert(emailFindings)
    .values({
      environmentId: input.environmentId,
      type: input.finding.type,
      impact: input.finding.impact,
      description: input.finding.description,
      status: "open",
      openedAt: input.at,
    })
    .onConflictDoUpdate({
      target: [emailFindings.environmentId, emailFindings.type],
      set: {
        impact: input.finding.impact,
        description: input.finding.description,
        status: "open",
        openedAt: input.at,
        closedAt: null,
        updatedAt: input.at,
      },
    });
}

/**
 * Record a finding as fixed.
 *
 * Closing a finding does NOT promote the tenant out of `watched`, and nothing
 * here attempts to: that is a human review (AUP §6.6). What it does is remove
 * the block on a human granting one.
 *
 * A close for a finding we never saw open inserts a closed row rather than
 * doing nothing, so the record of AWS having raised and resolved something is
 * kept even if we missed the open.
 */
export async function closeEmailFinding(input: {
  environmentId: string;
  finding: SesAbuseFinding;
  at: Date;
  db?: CloudDb;
}): Promise<void> {
  const db = input.db ?? defaultDb;
  await db
    .insert(emailFindings)
    .values({
      environmentId: input.environmentId,
      type: input.finding.type,
      impact: input.finding.impact,
      description: input.finding.description,
      status: "fixed",
      openedAt: input.at,
      closedAt: input.at,
    })
    .onConflictDoUpdate({
      target: [emailFindings.environmentId, emailFindings.type],
      set: {
        status: "fixed",
        closedAt: input.at,
        updatedAt: input.at,
      },
    });
}

/** Everything still open for this environment, newest first. */
export async function listOpenEmailFindings(input: {
  environmentId: string;
  db?: CloudDb;
}): Promise<EmailFindingRecord[]> {
  const db = input.db ?? defaultDb;
  const rows = await db
    .select({
      id: emailFindings.id,
      type: emailFindings.type,
      impact: emailFindings.impact,
      description: emailFindings.description,
      status: emailFindings.status,
      openedAt: emailFindings.openedAt,
      closedAt: emailFindings.closedAt,
    })
    .from(emailFindings)
    .where(
      and(
        eq(emailFindings.environmentId, input.environmentId),
        eq(emailFindings.status, "open"),
      ),
    )
    .orderBy(desc(emailFindings.openedAt));
  return rows;
}
