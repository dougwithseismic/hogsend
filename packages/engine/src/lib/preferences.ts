import type { Database } from "@hogsend/db";
import { emailPreferences } from "@hogsend/db";
import { sql } from "drizzle-orm";
import { resolveRecipient } from "./contacts.js";

/**
 * Single source of truth for an `email_preferences` upsert: the `(user_id, email)`
 * onConflict + the jsonb category-flip. Extracted from the private
 * `upsertPreference` that used to live in `routes/email/unsubscribe.ts` (decision
 * #9) so subscribe/unsubscribe routes, the preference center, list membership, and
 * the unsubscribe-token flow all share ONE write.
 *
 * `externalId` is the `user_id` column value: the contact's `external_id` when it
 * has one, else the contact `id` (uuid) fallback for an email-only contact (risk
 * 10). `email` is REQUIRED — both columns are NOT NULL and form the PK.
 */
export async function upsertEmailPreference(opts: {
  db: Database;
  externalId: string;
  email: string;
  update: {
    unsubscribedAll?: boolean;
    suppressed?: boolean;
    categoryKey?: string;
    categoryValue?: boolean;
  };
}): Promise<void> {
  const { db, externalId, email, update } = opts;

  const setClause: Record<string, unknown> = { updatedAt: new Date() };

  if (update.unsubscribedAll !== undefined) {
    setClause.unsubscribedAll = update.unsubscribedAll;
  }
  if (update.suppressed !== undefined) {
    setClause.suppressed = update.suppressed;
  }
  if (update.categoryKey !== undefined) {
    const jsonValue = update.categoryValue ? "true" : "false";
    setClause.categories = sql`jsonb_set(COALESCE(${emailPreferences.categories}, '{}'::jsonb), ${`{${update.categoryKey}}`}, ${jsonValue}::jsonb)`;
  }

  await db
    .insert(emailPreferences)
    .values({
      userId: externalId,
      email,
      ...(update.unsubscribedAll !== undefined
        ? { unsubscribedAll: update.unsubscribedAll }
        : {}),
      ...(update.suppressed !== undefined
        ? { suppressed: update.suppressed }
        : {}),
      ...(update.categoryKey !== undefined
        ? {
            categories: { [update.categoryKey]: update.categoryValue ?? false },
          }
        : {}),
    })
    .onConflictDoUpdate({
      target: [emailPreferences.userId, emailPreferences.email],
      set: setClause,
    });
}

/**
 * D3 list-membership write. Resolves the caller's identity to the deterministic
 * `(externalId | contactId fallback, email)` pair via `resolveRecipient`, then
 * writes one category flip per list key through `upsertEmailPreference`.
 *
 * Requires a resolvable email — `email_preferences.email` is NOT NULL and the
 * preference center / unsubscribe-token flow key on it (risk 10). The caller is
 * expected to have already run `resolveOrCreateContact` (so the contact exists);
 * this reads identity back. Throws if no email can be resolved — the route maps
 * that to a 400 ("Contact has no email; cannot manage list membership").
 */
export async function applyListMembership(opts: {
  db: Database;
  userId?: string;
  email?: string;
  lists: Record<string, boolean>;
}): Promise<void> {
  const { db, userId, email, lists } = opts;

  const entries = Object.entries(lists);
  if (entries.length === 0) return;

  const recipient = await resolveRecipient({ db, userId, email });
  if (!recipient) {
    throw new Error("Contact has no email; cannot manage list membership");
  }

  // `user_id` column = external_id when present, else the contact id (uuid)
  // fallback — the SAME deterministic key used by subscribe writes,
  // preference-center reads, and unsubscribe-token issuance (risk 10).
  const externalId = recipient.externalId ?? recipient.contactId;

  for (const [categoryKey, categoryValue] of entries) {
    await upsertEmailPreference({
      db,
      externalId,
      email: recipient.email,
      update: { categoryKey, categoryValue },
    });
  }
}
