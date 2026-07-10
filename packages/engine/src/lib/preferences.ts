import type { Database } from "@hogsend/db";
import { emailPreferences } from "@hogsend/db";
import { eq, or, sql } from "drizzle-orm";
import { resolveRecipient } from "./contacts.js";
import { hatchet } from "./hatchet.js";
import { createLogger } from "./logger.js";
import { emitOutbound } from "./outbound.js";

const logger = createLogger(process.env.LOG_LEVEL);

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
 *
 * `emitOutbound` (default true) gates the `contact.unsubscribed` outbound emit.
 * Bulk historical imports (import-suppressions) pass false: a 50k-row import
 * must not fan out 50k opt-out events for opt-outs that happened on another
 * platform months ago. Every interactive caller keeps the default.
 */
export async function upsertEmailPreference(opts: {
  db: Database;
  externalId: string;
  email: string;
  update: {
    unsubscribedAll?: boolean;
    suppressed?: boolean;
    /** Set `suppressed_at` explicitly (used alongside `suppressed: true`). */
    suppressedAt?: Date;
    /**
     * Record an imported hard bounce: `bounce_count = GREATEST(bounce_count, 1)`
     * + `last_bounce_at = now`. GREATEST (not increment) so re-running an import
     * is idempotent and never inflates a genuine bounce history.
     */
    recordBounce?: boolean;
    categoryKey?: string;
    categoryValue?: boolean;
  };
  emitOutbound?: boolean;
}): Promise<void> {
  const { db, externalId, email, update } = opts;

  const setClause: Record<string, unknown> = { updatedAt: new Date() };

  if (update.unsubscribedAll !== undefined) {
    setClause.unsubscribedAll = update.unsubscribedAll;
  }
  if (update.suppressed !== undefined) {
    setClause.suppressed = update.suppressed;
  }
  if (update.suppressedAt !== undefined) {
    setClause.suppressedAt = update.suppressedAt;
  }
  if (update.recordBounce) {
    setClause.bounceCount = sql`GREATEST(${emailPreferences.bounceCount}, 1)`;
    setClause.lastBounceAt = new Date();
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
      ...(update.suppressedAt !== undefined
        ? { suppressedAt: update.suppressedAt }
        : {}),
      ...(update.recordBounce
        ? { bounceCount: 1, lastBounceAt: new Date() }
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

  // OUTBOUND `contact.unsubscribed` — this is the SINGLE choke for ALL preference
  // writes (token unsub, preference center, list-membership flips), so the emit
  // lives here once. GATED to a genuine opt-OUT only: a full unsubscribe
  // (`unsubscribedAll === true`) or a category flip to false. A resubscribe
  // (`unsubscribedAll === false` / `categoryValue === true`) does NOT emit. Uses
  // the engine `hatchet`/`logger` singletons (this lib has no request container);
  // fire-and-forget so a transient outbound error never fails the pref write.
  const isUnsubscribe =
    update.unsubscribedAll === true || update.categoryValue === false;
  if (isUnsubscribe && (opts.emitOutbound ?? true)) {
    const scope: "all" | "category" =
      update.unsubscribedAll === true ? "all" : "category";
    void emitOutbound({
      db,
      hatchet,
      logger,
      event: "contact.unsubscribed",
      payload: {
        externalId,
        email,
        category: update.categoryKey ?? null,
        scope,
      },
    }).catch(logger.warn);
  }
}

/**
 * Aggregated preference verdict for a recipient, folded across EVERY matching
 * `email_preferences` row. See {@link readRecipientPreferences}.
 */
export interface RecipientPreferences {
  /** true when ANY matching row has unsubscribed_all (global master opt-out). */
  unsubscribedAll: boolean;
  /**
   * true when ANY matching row is suppressed (hard bounce / complaint).
   * Email-transport-specific — channel checks must NOT consume this.
   */
  suppressed: boolean;
  /** Category map merged across ALL matching rows, explicit false winning. */
  categories: Record<string, boolean>;
}

/**
 * The ONE aggregated preference READ shared by the email mailer (checkSuppression),
 * the in-app feed, and connector-send gating. Selects EVERY `email_preferences`
 * row matching the given identity keys and folds them into a single verdict.
 *
 * An address can legitimately have MORE THAN ONE row: the `(user_id, email)`
 * composite PK means a suppression imported before the contact existed is keyed
 * (email, email) while later interactive writes key (external_id, email). We
 * aggregate across ALL matching rows — any suppression signal on ANY row must
 * win — so an imported unsubscribe/bounce can never be shadowed by a newer clean
 * row for the same address.
 *
 * Rows are selected `WHERE email = keys.email OR user_id = keys.userId`, each leg
 * included ONLY when its key is a non-empty string. With NEITHER key provided we
 * do NOT query and return the empty/clean default.
 *
 * Category maps are merged with explicit FALSE winning: `categories[key] =
 * (categories[key] ?? true) && value` over every row's map — an opt-out recorded
 * on any row blocks, matching the conservative aggregation above. (In the common
 * single-row case this is identical to reading the row's map directly.)
 */
export async function readRecipientPreferences(
  db: Database,
  keys: { email?: string | null; userId?: string | null },
): Promise<RecipientPreferences> {
  // Build the OR legs conditionally — an empty/absent key contributes NO leg, so
  // a `{ email }`-only read never matches every `user_id = ''` row and vice versa.
  const legs = [];
  if (typeof keys.email === "string" && keys.email.length > 0) {
    legs.push(eq(emailPreferences.email, keys.email));
  }
  if (typeof keys.userId === "string" && keys.userId.length > 0) {
    legs.push(eq(emailPreferences.userId, keys.userId));
  }

  // Neither key: do NOT query — a bare `.where()`/`or()` with no legs would match
  // the whole table. Return the clean default instead.
  if (legs.length === 0) {
    return { unsubscribedAll: false, suppressed: false, categories: {} };
  }

  const rows = await db
    .select()
    .from(emailPreferences)
    .where(or(...legs));

  // Merge category maps across rows with explicit FALSE winning (see JSDoc). This
  // always runs — an absent/empty map contributes nothing, so the result is `{}`.
  const categories: Record<string, boolean> = {};
  for (const prefs of rows) {
    const map = (prefs.categories ?? {}) as Record<string, boolean>;
    for (const [key, value] of Object.entries(map)) {
      categories[key] = (categories[key] ?? true) && value;
    }
  }

  return {
    unsubscribedAll: rows.some((r) => r.unsubscribedAll),
    suppressed: rows.some((r) => r.suppressed),
    categories,
  };
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
