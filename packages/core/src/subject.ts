import { type Column, eq, type SQL } from "drizzle-orm";

/**
 * Structural shape of the five history tables keyed on BOTH the mutable text
 * key (`user_id`) and the owning contact (`contact_id`): `user_events`,
 * `journey_states`, `bucket_memberships`, `email_sends`, `email_preferences`.
 */
export interface SubjectScopedTable {
  contactId: Column;
  userId: Column;
}

/**
 * Who a history read is about: the owning contact when one is known, plus the
 * canonical text key (`external_id ?? anonymous_id ?? id`) as the fallback.
 */
export interface Subject {
  contactId: string | null | undefined;
  userKey: string;
}

/**
 * Scope a history query to one subject — EITHER by `contact_id` OR by
 * `user_id`, never an `OR` of both.
 *
 * The either/or is the point, and it is a correctness constraint the code
 * cannot show on its own: once a contact row exists, every one of its history
 * rows carries `contact_id` (the dual-write + backfill guarantee), so an `OR`
 * arm would only add a redundant text scan — and it would re-open the
 * cross-namespace string-collision bugs where one contact's `user_id` value
 * matches an unrelated contact's key.
 */
export function bySubject(table: SubjectScopedTable, subject: Subject): SQL {
  return subject.contactId
    ? eq(table.contactId, subject.contactId)
    : eq(table.userId, subject.userKey);
}
