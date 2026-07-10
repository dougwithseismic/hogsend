import { emailPreferences, type FeedBlock, feedItems } from "@hogsend/db";
import { and, eq } from "drizzle-orm";
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

  // (2) `in_app` suppression check. Suppression is governed by the `in_app` list
  // key regardless of the item's own category. `email_preferences` is
  // `(user_id, email)`-keyed; an anon-only recipient has no pref row → categories
  // = {} → opt-in default → not suppressed (you cannot suppress what has no
  // preference surface yet). `unsubscribed_all` on an identified recipient DOES
  // suppress, consistent with the email mailer's `checkEmailPreferences`.
  let categories: Record<string, boolean> = {};
  const recip = await resolveRecipient({
    db,
    userId: recipient.userId,
    email: recipient.email,
  });
  if (recip) {
    const extId = recip.externalId ?? recip.contactId;
    const rows = await db
      .select()
      .from(emailPreferences)
      .where(
        and(
          eq(emailPreferences.userId, extId),
          eq(emailPreferences.email, recip.email),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (row) {
      if (row.unsubscribedAll) {
        return {
          feedItemId: null,
          recipientKey,
          suppressed: true,
          createdAt: null,
        };
      }
      categories = (row.categories ?? {}) as Record<string, boolean>;
    }
  }
  if (!getListRegistry().isSubscribed(categories, IN_APP_LIST_ID)) {
    return {
      feedItemId: null,
      recipientKey,
      suppressed: true,
      createdAt: null,
    };
  }

  // (3) Replay-safe idempotency key (mirrors `sendEmail`). The `feed:`-namespaced
  // discriminant realizes the plan's `feedSend:<runAnchor>:<site>:<type>` shape
  // through the SAME branch-stable key engine (one primitive, not a fork).
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

  // Layer 1 (eviction-gated, FREE) fast path. When inside a journey on an
  // eviction-capable engine, a replay returns the recorded result WITHOUT
  // re-hitting the DB; Layer 2 (`onConflictDoNothing`) is the version-independent
  // backstop. Outside a journey, run directly.
  if (boundary && key) {
    return boundary.memoize([key], doInsertAndPublish);
  }
  return doInsertAndPublish();
}
