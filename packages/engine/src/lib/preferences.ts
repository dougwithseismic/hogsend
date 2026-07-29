import type { Database } from "@hogsend/db";
import { emailPreferences } from "@hogsend/db";
import { and, eq, sql } from "drizzle-orm";
import { lookupContactIdByKey, resolveRecipient } from "./contacts.js";
import { hatchet } from "./hatchet.js";
import { createLogger } from "./logger.js";
import { emitOutbound } from "./outbound.js";
import {
  isUniqueViolationOn,
  UQ_CONTACT_EMAIL_PREFERENCES,
} from "./unique-violation.js";

export {
  type RecipientPreferences,
  readRecipientPreferences,
} from "./recipient-preferences.js";

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
  /**
   * Grant provenance carried on the `contact.subscribed` emit: `"api"`
   * (default), `"preference_center"`, `"started_keyword"`, `"import"`.
   * TCPA record-keeping is the "how" as much as the "when".
   */
  source?: string;
  /**
   * PRD 04 dual-write: the `contacts.id` owning `externalId`.
   *
   * `undefined` (the default, and every caller that has nothing in hand) ⇒ this
   * function does ONE D6-wrapped lookup itself. An EXPLICIT value — including
   * an explicit `null` — is used verbatim, so a caller that already resolved
   * the contact (the lists route, one line after `resolveOrCreateContact`) pays
   * no second query and cannot disagree with itself.
   */
  contactId?: string | null;
}): Promise<void> {
  const { db, externalId, email, update } = opts;

  // D6 — the resolve may never fail the preference write it rides on: a throw
  // degrades to NULL + a warn. The probe is paid ONLY when the caller supplied
  // nothing; the discriminant is `undefined` (not falsiness), so an EXPLICIT
  // null stays an explicit null rather than triggering a lookup.
  let contactId: string | null = null;
  if (opts.contactId !== undefined) {
    contactId = opts.contactId;
  } else {
    try {
      contactId = await lookupContactIdByKey(db, externalId);
    } catch (err) {
      logger.warn("email_preferences contact_id dual-write resolve failed", {
        externalId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const setClause: Record<string, unknown> = {
    updatedAt: new Date(),
    // FILL-IF-KNOWN, NEVER NULL-OUT (house precedent: the fill-if-absent
    // refinement, PR #615). The conflict arm takes the incoming id when there is
    // one and otherwise KEEPS what the row already carries — so a failed or
    // impossible resolve on a later write can never erase a `contact_id` an
    // earlier write successfully stamped.
    contactId: sql`coalesce(excluded.contact_id, ${emailPreferences.contactId})`,
  };

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

  const upsertOnStringKey = () =>
    db
      .insert(emailPreferences)
      .values({
        userId: externalId,
        email,
        contactId,
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
              categories: {
                [update.categoryKey]: update.categoryValue ?? false,
              },
            }
          : {}),
      })
      .onConflictDoUpdate({
        target: [emailPreferences.userId, emailPreferences.email],
        set: setClause,
      });

  try {
    await upsertOnStringKey();
  } catch (err) {
    // PRD 05 T3 — the arbiter STAYS on (user_id, email); the contact-scoped
    // index is a pure constraint (drizzle targets columns only, and a bare
    // (contact_id, email) arbiter would never fire for the contactless
    // population — a D6-degraded NULL resolve is legal and permanent). So the
    // one collision the string arbiter cannot see — SAME contact, SAME address,
    // DIFFERENT `user_id` string, which is exactly what adoption produces when
    // it stamps `contact_id` without rewriting `user_id` — arrives here as a
    // 23505 and is converted into the update path by hand.
    if (!contactId || !isUniqueViolationOn(err, UQ_CONTACT_EMAIL_PREFERENCES)) {
      throw err;
    }
    // `contactId` is dropped from the set: it only existed to carry the
    // `excluded.contact_id` coalesce, which has no meaning outside ON CONFLICT,
    // and the row we are about to update already holds THIS id (that is how it
    // collided). Every other entry references the table column, which is legal
    // on the right-hand side of a plain UPDATE.
    const { contactId: _excludedCoalesce, ...contactScopedSet } = setClause;
    const converted = await db
      .update(emailPreferences)
      .set(contactScopedSet)
      .where(
        and(
          eq(emailPreferences.contactId, contactId),
          eq(emailPreferences.email, email),
        ),
      )
      .returning({ id: emailPreferences.id });

    // ZERO rows means the conflicting row vanished between the INSERT and this
    // UPDATE — a concurrent merge folded it away (`foldEmailPreferences` hard-
    // deletes the row it absorbed) or re-pointed its `contact_id`. Accepting
    // that silently DROPS the write while the emit below still announces an
    // opt-out that never landed. The conflicting row is gone, so the original
    // arbiter INSERT now has somewhere to go: retry it ONCE. A second 23505
    // means another writer re-created the row in this same gap — that throws,
    // which is the loud answer, not a silent loss.
    if (converted.length === 0) await upsertOnStringKey();
  }

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

  // The opt-IN mirror: `contact.subscribed` on a genuine grant (resubscribe-all
  // or a category flip to true) — the consent audit signal for opt-in channels
  // (the explicit-consent `sms` channel above all). Same choke, same
  // fire-and-forget semantics, same `emitOutbound: false` escape for bulk
  // imports. A redundant re-grant re-emits, identical to the opt-out side.
  const isSubscribe =
    !isUnsubscribe &&
    (update.unsubscribedAll === false || update.categoryValue === true);
  if (isSubscribe && (opts.emitOutbound ?? true)) {
    const scope: "all" | "category" =
      update.categoryKey !== undefined ? "category" : "all";
    void emitOutbound({
      db,
      hatchet,
      logger,
      event: "contact.subscribed",
      payload: {
        externalId,
        email,
        category: update.categoryKey ?? null,
        scope,
        source: opts.source ?? "api",
      },
    }).catch(logger.warn);
  }
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
