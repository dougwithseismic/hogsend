import type { CloudDb } from "../db";
import { cloudAuditLog } from "../db/schema";

/**
 * The transaction handle drizzle hands a `db.transaction(cb)` callback. Every
 * writer in this layer accepts `CloudDb | CloudTx` so a mutation can be composed
 * INTO a caller's transaction — which is the whole point for `OrgService.create`,
 * where the org, its environment, its stack and the audit row must land together
 * or not at all.
 */
export type CloudTx = Parameters<Parameters<CloudDb["transaction"]>[0]>[0];
export type CloudWriter = CloudDb | CloudTx;

export interface AuditEntry {
  /** A user id, an API key id, or a system actor like "provisioner". */
  actor?: string | undefined;
  organizationId: string;
  /** Dotted verb: "org.created", "environment.removed", … */
  action: string;
  /** The affected row's id or natural key. */
  subject: string;
  detail?: Record<string, unknown>;
}

/**
 * Append one control-plane audit row. Shared rather than re-implemented per
 * service so "every mutation is audited" (PRD 02 EARS) has exactly one shape,
 * and so an audit write always runs on the SAME writer as the mutation it
 * describes — an audit row that survived a rolled-back change would be a lie.
 */
export async function writeAudit(
  writer: CloudWriter,
  entry: AuditEntry,
): Promise<void> {
  await writer.insert(cloudAuditLog).values({
    actor: entry.actor ?? "system",
    organizationId: entry.organizationId,
    action: entry.action,
    subject: entry.subject,
    detail: entry.detail ?? {},
  });
}
