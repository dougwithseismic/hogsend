import { type FeedBlock, feedItems } from "@hogsend/db";
import {
  deriveJourneyKey,
  getJourneyBoundary,
  registerKey,
} from "../journeys/journey-boundary.js";
import { IN_APP_LIST_ID } from "../lists/channels.js";
import { getListRegistry } from "../lists/registry-singleton.js";
import { resolveOrCreateContact, resolveRecipient } from "./contacts.js";
import { getDb } from "./db.js";
import { createLogger } from "./logger.js";
import { readRecipientPreferences } from "./preferences.js";
import { getRedis } from "./redis.js";

const logger = createLogger(process.env.LOG_LEVEL);

/**
 * Reserved list id governing in-app feed suppression (mirrors the built-in
 * `transactional` / `journey` categories). A recipient unsubscribed from
 * `in_app` (or `unsubscribed_all`) gets no feed items. Canonically defined in
 * `../lists/channels.js` (where the in-app channel is synthesized); re-exported
 * here so the engine's existing export surface stays stable.
 */
export { IN_APP_LIST_ID };

export interface SendFeedItemOptions {
  recipient: { userId?: string; email?: string; anonymousId?: string };
  type: string;
  title?: string;
  body?: string;
  blocks?: FeedBlock[];
  actionUrl?: string;
  metadata?: Record<string, unknown>;
  /** Item category (the feed it lands in). Default `"in_app"`. */
  category?: string;
  templateKey?: string;
  journeyStateId?: string;
  /**
   * Explicit idempotency key. A public caller sets it directly; it always wins
   * over the engine's journey auto-derivation. Journey sends leave it unset.
   */
  idempotencyKey?: string;
  /**
   * Disambiguates the exactly-once key when the SAME feed type is sent more than
   * once in one journey enrollment on divergent branches sharing a nearest wait
   * label. Mirrors `sendEmail()`'s `idempotencyLabel`. Additive and optional.
   */
  idempotencyLabel?: string;
}

export interface SendFeedItemResult {
  /** The inserted row id, or `null` when suppressed or idempotent-deduped. */
  feedItemId: string | null;
  /** The resolved canonical recipient key (null only when no recipient given). */
  recipientKey: string | null;
  suppressed: boolean;
  createdAt: string | null;
}

/**
 * Journey-callable in-app feed send — the standalone, single-object-in /
 * result-out counterpart to `sendEmail()` / `sendConnectorAction()`. NOT on
 * `JourneyContext` (features are standalone imports).
 *
 * Pipeline: resolve recipient → canonical key → `in_app` suppression check →
 * insert a `feed_items` row (replay-safe idempotency when in a journey) → publish
 * to the Redis realtime channel `feed:<recipientKey>` on the COMMAND singleton.
 *
 * Replay-safety mirrors `sendEmail()`: inside a journey the engine derives a
 * deterministic, branch-stable key off `boundary.runAnchor` (the Hatchet run id,
 * NOT the freshly-minted state id) so a replay re-firing the same logical send
 * re-derives the SAME key and the unique `feed_items.idempotencyKey` index
 * (`onConflictDoNothing`, Layer 2) absorbs the duplicate insert. When eviction is
 * supported, the whole insert+publish runs inside `boundary.memoize` (Layer 1).
 */
export async function sendFeedItem(
  opts: SendFeedItemOptions,
): Promise<SendFeedItemResult> {
  const db = getDb();
  const { recipient } = opts;
  const category = opts.category ?? IN_APP_LIST_ID;

  // (1) Resolve recipient → canonical key. Throws on a zero-key recipient (same
  // contract as `resolveOrCreateContact`). This is a server/journey-side send —
  // never a browser write — so no `restrictToAnonymous` clamp.
  const { id: contactId, resolvedKey } = await resolveOrCreateContact({
    db,
    userId: recipient.userId,
    email: recipient.email,
    anonymousId: recipient.anonymousId,
  });
  const recipientKey = resolvedKey;

  // (2) Replay-safe idempotency key (mirrors `sendEmail`), derived
  // UNCONDITIONALLY — BEFORE any preference decision. The `feed:`-namespaced
  // discriminant realizes the plan's `feedSend:<runAnchor>:<site>:<type>` shape
  // through the SAME branch-stable key engine (one primitive, not a fork).
  //
  // THE LAW: the Hatchet journal is positional, and `boundary.memoize` (step 4)
  // is a durable call, so its issuance must never be conditional on a live
  // preference read. A recipient's `in_app`/`unsubscribed_all` state can flip
  // between an original run and a replay-from-top; the OLD code early-returned on
  // that read HERE, before the key derivation + `registerKey` + `memoize`, so a
  // flip made the replay conditionally skip (or add) the memoize durable call →
  // positional journal shift → the run is killed with a non-determinism error.
  // The fix (mirroring the connector gate in lib/connector-actions.ts): derive +
  // register the key and issue the memoize UNCONDITIONALLY, and fold the whole
  // preference verdict INSIDE the memo closure (step 3) so the skip/allow verdict
  // is RECORDED by the durable memo and replays verbatim — the live-flipped
  // preference is never re-read on a replay.
  const boundary = getJourneyBoundary();
  let key: string | undefined = opts.idempotencyKey;
  if (!key && boundary) {
    const site = opts.idempotencyLabel ?? boundary.currentLabel ?? opts.type;
    key = deriveJourneyKey({
      kind: "send",
      anchor: boundary.runAnchor,
      site,
      discriminant: `feed:${opts.type}`,
    });
    registerKey(boundary, key);
  }

  const doInsertAndPublish = async (): Promise<SendFeedItemResult> => {
    // (4) Insert. `onConflictDoNothing` on the idempotency unique index (Layer 2,
    // version-independent). A NULL key never conflicts (NULLs distinct) → always
    // inserts.
    const rows = await db
      .insert(feedItems)
      .values({
        recipientKey,
        contactId,
        type: opts.type,
        title: opts.title,
        body: opts.body,
        blocks: opts.blocks,
        actionUrl: opts.actionUrl,
        metadata: opts.metadata,
        journeyStateId: opts.journeyStateId,
        templateKey: opts.templateKey,
        category,
        idempotencyKey: key,
      })
      .onConflictDoNothing({ target: feedItems.idempotencyKey })
      .returning({ id: feedItems.id, createdAt: feedItems.createdAt });

    const row = rows[0];
    if (!row) {
      // Idempotent dedup (a prior insert with this key won) — no publish, no
      // double.
      return {
        feedItemId: null,
        recipientKey,
        suppressed: false,
        createdAt: null,
      };
    }

    // (5) Publish on the COMMAND singleton (never `.subscribe()` here — that is
    // the SSE route's dedicated duplicate). Publish failure is non-fatal: the row
    // is persisted, the next poll/fetch sees it.
    try {
      await getRedis().publish(
        `feed:${recipientKey}`,
        JSON.stringify({
          type: "item.new",
          item: {
            id: row.id,
            type: opts.type,
            title: opts.title ?? null,
            body: opts.body ?? null,
            blocks: opts.blocks ?? null,
            actionUrl: opts.actionUrl ?? null,
            metadata: opts.metadata ?? null,
            category,
            status: "unseen",
            createdAt: row.createdAt.toISOString(),
          },
        }),
      );
    } catch (err) {
      logger.warn("feed publish failed", {
        recipientKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return {
      feedItemId: row.id,
      recipientKey,
      suppressed: false,
      createdAt: row.createdAt.toISOString(),
    };
  };

  // (3) `in_app` suppression gate + insert/publish, folded into ONE closure so
  // the whole verdict (skip OR insert) is recorded by the durable memo (step 4)
  // and replays byte-identically. Suppression is governed by the `in_app`
  // channel list regardless of the item's own category.
  //
  // The preference read is the UNIFIED aggregated `readRecipientPreferences`
  // keyed by BOTH the recipient's `external_id ?? contact_id` AND its email —
  // NOT the old single-row `(extId, email)` lookup. This is a deliberate,
  // suppression-conservative behaviour change: an `unsubscribed_all` (or category
  // opt-out) imported before the contact existed and keyed `(email, email)` now
  // suppresses the feed too, exactly as it already suppresses email. An anon-only
  // recipient has no preference surface (`resolveRecipient` → null), so
  // `unsubscribed_all` is not consulted (you cannot suppress what has no pref row
  // yet); the `in_app` channel check still runs, but empty categories → opt-in
  // default → subscribed, so an anon recipient is never suppressed here.
  const doGatedInsertAndPublish = async (): Promise<SendFeedItemResult> => {
    const recip = await resolveRecipient({
      db,
      userId: recipient.userId,
      email: recipient.email,
    });
    // `external_id ?? contact_id` — the SAME identity key the old single-row read
    // used (and that preference writes key on). Undefined for an anon recipient.
    const extId = recip ? (recip.externalId ?? recip.contactId) : undefined;
    const prefs = await readRecipientPreferences(db, {
      email: recip?.email,
      userId: extId,
    });
    // `unsubscribed_all` on an IDENTIFIED recipient suppresses (consistent with
    // the email mailer's `checkEmailPreferences`); guarded on `recip` so an
    // anon recipient with no preference surface is never blocked.
    if (recip && prefs.unsubscribedAll) {
      return {
        feedItemId: null,
        recipientKey,
        suppressed: true,
        createdAt: null,
      };
    }
    if (!getListRegistry().isSubscribed(prefs.categories, IN_APP_LIST_ID)) {
      return {
        feedItemId: null,
        recipientKey,
        suppressed: true,
        createdAt: null,
      };
    }
    return doInsertAndPublish();
  };

  // (4) Layer 1 (eviction-gated, FREE) fast path. When inside a journey on an
  // eviction-capable engine, a replay returns the recorded result (a skip verdict
  // OR the insert result) WITHOUT re-reading preferences or re-hitting the DB;
  // Layer 2 (`onConflictDoNothing`) is the version-independent backstop. Outside
  // a journey, run directly. The key derivation, `registerKey`, and this
  // `memoize` call all stay UNCONDITIONAL (THE LAW) — the preference verdict
  // lives inside the closure, never gating the durable call itself.
  if (boundary && key) {
    return boundary.memoize([key], doGatedInsertAndPublish);
  }
  return doGatedInsertAndPublish();
}
