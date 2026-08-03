import { type FeedBlock, feedItems } from "@hogsend/db";
import {
  deriveJourneyKey,
  getJourneyBoundary,
  registerKey,
} from "../journeys/journey-boundary.js";
import { IN_APP_LIST_ID } from "../lists/channels.js";
import { getListRegistry } from "../lists/registry-singleton.js";
import {
  ALL_IDENTITY_KINDS,
  type ResolvePolicy,
  resolveContactNoCreate,
  resolveOrCreateContact,
  resolveRecipient,
} from "./contacts.js";
import { getDb } from "./db.js";
import { createLogger } from "./logger.js";
import { readRecipientPreferences } from "./recipient-preferences.js";
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
  const { recipient } = opts;
  // Keep the production recipient contract in front of the scoped test
  // override.  The normal path eventually enforces this in
  // `resolveOrCreateContact`, but an override deliberately avoids the database;
  // without this pure check a zero-recipient feed item passed in journey tests
  // and failed only in production.
  if (
    !recipient.userId?.trim() &&
    !recipient.email?.trim() &&
    !recipient.anonymousId?.trim()
  ) {
    throw new Error(
      "resolveOrCreateContact requires at least one of userId, email, " +
        "anonymousId, discordId",
    );
  }
  const category = opts.category ?? IN_APP_LIST_ID;

  const boundary = getJourneyBoundary();
  const override = boundary?.services?.feed;
  if (boundary && override) {
    let overrideKey: string | undefined = opts.idempotencyKey;
    if (!overrideKey) {
      const site = opts.idempotencyLabel ?? boundary.currentLabel ?? opts.type;
      overrideKey = deriveJourneyKey({
        kind: "send",
        anchor: boundary.runAnchor,
        site,
        discriminant: `feed:${opts.type}`,
      });
      registerKey(boundary, overrideKey);
    }
    const runOverride = () =>
      override({
        recipient,
        type: opts.type,
        ...(opts.title !== undefined ? { title: opts.title } : {}),
        ...(opts.body !== undefined ? { body: opts.body } : {}),
        ...(opts.blocks !== undefined ? { blocks: opts.blocks } : {}),
        ...(opts.actionUrl !== undefined ? { actionUrl: opts.actionUrl } : {}),
        ...(opts.metadata !== undefined ? { metadata: opts.metadata } : {}),
        category,
        ...(opts.templateKey !== undefined
          ? { templateKey: opts.templateKey }
          : {}),
        ...(opts.journeyStateId !== undefined
          ? { journeyStateId: opts.journeyStateId }
          : {}),
        ...(overrideKey ? { idempotencyKey: overrideKey } : {}),
      });
    return overrideKey
      ? boundary.memoize([overrideKey], runOverride)
      : runOverride();
  }

  const db = getDb();

  // (1) Resolve recipient → canonical key. Throws on a zero-key recipient (same
  // contract as `resolveOrCreateContact`). This is a server/journey-side send —
  // never a browser write — so no `restrictToAnonymous` clamp.
  //
  // OBSERVATION, NOT ASSERTION (D1) — on the PURE-`anonymousId` arm, and only
  // there. A browser anon id handed to a journey is not an identity anyone
  // asserted; re-resolving it is observation. Left creating, an anonymous in-app
  // visitor gets an `external_id = <anonId>` row — and `resolveFeedRecipient`
  // then rejects a publishable `anonymousId` that collides with an identified
  // contact's canonical key, so the ghost 403-LOCKS that visitor out of their
  // own bell.
  //
  // So a MISS on a recipient carrying ONLY an `anonymousId` refuses to mint.
  // Nothing is lost: `resolveContactNoCreate` returns the SAME `resolvedKey` the
  // create arm would have made canonical (`external_id ?? anonymous_id`), which
  // is byte-identical to the key the bell polls, and `feed_items.contact_id` is
  // nullable with no foreign key (verified against the 0034 DDL), so the row
  // still lands and still reads back. A HIT is untouched — it links/merges
  // exactly as before.
  //
  // THE `userId` ARM KEEPS CREATING, and its mint is LOAD-BEARING FOR
  // CONFIDENTIALITY — not merely a ghost. `sendFeedItem` stores an identified
  // recipient's rows under that recipient's canonical key, and the minted row is
  // the ONLY signal `collidesWithIdentified` (contacts.ts) has that the string is
  // somebody's key. Refuse the mint and nothing collides, so the publishable ANON
  // arm of `resolveFeedRecipient` (routes/feed/recipient.ts) accepts
  // `?anonymousId=<that userId>` as a self-addressing anon id and hands the
  // caller that recipient's feed items — plus mark / mark-all over them.
  // Refusing here silently converts a private feed row into an anon-addressable
  // one. D1 says the same thing from the other end: a server-asserted `userId`
  // IS a minting trigger.
  //
  // The other two conjuncts are D8:
  //   - an asserted `email` KEEPS CREATING. It is a durable identity the caller
  //     is asserting (D1), and it is never a canonical key — so refusing it
  //     would key history on a row uuid that was never minted, which is exactly
  //     the misuse `resolveContactNoCreate` THROWS on.
  //   - no `anonymousId` ⇒ there is no stable key to refuse WITH; same throw.
  //     (A zero-key recipient already threw above.)
  const refusable =
    !recipient.email?.trim() &&
    !recipient.userId?.trim() &&
    !!recipient.anonymousId?.trim();
  // PRD 06 T4 (L5 rows 10-11): trust is DECLARED by this caller. A feed send
  // is a journey/server-side write, never a browser assertion, so it declares
  // full server trust — `allowMerge: "any"` (no clamp) and all four kinds.
  // Only the `create` leg varies, keyed off the SAME `refusable` verdict that
  // selects the entry point below, so the policy and the entry point can
  // never disagree (each entry point throws on a mismatched `create`).
  const policy: ResolvePolicy = {
    create: refusable ? "refuse-on-miss" : "on-miss",
    allowMerge: "any",
    trustedKinds: ALL_IDENTITY_KINDS,
  };
  const resolveOpts = {
    db,
    userId: recipient.userId,
    email: recipient.email,
    anonymousId: recipient.anonymousId,
    policy,
  };
  const { id: contactId, resolvedKey } = refusable
    ? await resolveContactNoCreate(resolveOpts)
    : await resolveOrCreateContact(resolveOpts);
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
  // keyed by BOTH the recipient's resolved `contact_id` AND its email —
  // NOT the old single-row `(extId, email)` lookup. This is a deliberate,
  // suppression-conservative behaviour change: an `unsubscribed_all` (or category
  // opt-out) imported before the contact existed and keyed `(email, email)` now
  // suppresses the feed too, exactly as it already suppresses email. An anon-only
  // recipient has no preference surface (`resolveRecipient` → null), so
  // `unsubscribed_all` is not consulted (you cannot suppress what has no pref row
  // yet); the `in_app` channel check still runs, but empty categories → opt-in
  // default → subscribed, so an anon recipient is never suppressed here.
  const doGatedInsertAndPublish = async (): Promise<SendFeedItemResult> => {
    const suppressedResult: SendFeedItemResult = {
      feedItemId: null,
      recipientKey,
      suppressed: true,
      createdAt: null,
    };
    const recip = await resolveRecipient({
      db,
      userId: recipient.userId,
      email: recipient.email,
    });
    // PRD 05 T6 — contact-scoped read (the resolved contact id IS the subject);
    // the old `external_id ?? contact_id` string derivation is retired. Null
    // for an anon recipient: email leg only, same as before.
    const prefs = await readRecipientPreferences(db, {
      email: recip?.email,
      contactId: recip?.contactId ?? null,
    });
    // `unsubscribed_all` on an IDENTIFIED recipient suppresses (consistent with
    // the email mailer's `checkEmailPreferences`); guarded on `recip` so an
    // anon recipient with no preference surface is never blocked.
    if (recip && prefs.unsubscribedAll) {
      return suppressedResult;
    }
    if (!getListRegistry().isSubscribed(prefs.categories, IN_APP_LIST_ID)) {
      return suppressedResult;
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
