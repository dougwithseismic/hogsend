import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./_shared.js";

/**
 * A renderable content block on a feed item — the typed union behind
 * `feed_items.blocks`. Minimal but real (text / button / image); new kinds are
 * additive (no migration — it's jsonb). Mirrors Knock's block model.
 */
export type FeedBlock =
  | { type: "text"; text: string }
  | { type: "button"; label: string; url: string }
  | { type: "image"; url: string; alt?: string };

export const feedItemStatus = pgEnum("feed_item_status", [
  "unseen",
  "seen",
  "read",
  "archived",
]);

/**
 * One row per (recipient, message). Mirrors `email_sends`' denormalized-recipient
 * + inline lifecycle `*At` + idempotency shape — a single table, no
 * message/recipient split (instance-scale → single index scan, no join).
 *
 * `recipientKey` is the canonical text key (`external_id ?? anonymous_id ?? id`),
 * ALIAS-RESOLVED ON WRITE (sendFeedItem resolves the contact first). A merge
 * re-points loser→survivor the same way `user_events`/`email_sends` do.
 * Suppression is governed by `email_preferences.categories["in_app"]` +
 * `ListRegistry.isSubscribed` — zero new prefs plumbing.
 */
export const feedItems = pgTable(
  "feed_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    recipientKey: text("recipient_key").notNull(),
    contactId: uuid("contact_id"),
    type: text("type").notNull(),
    title: text("title"),
    body: text("body"),
    blocks: jsonb("blocks").$type<FeedBlock[]>(),
    actionUrl: text("action_url"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    journeyStateId: uuid("journey_state_id"),
    templateKey: text("template_key"),
    category: text("category").notNull().default("in_app"),
    status: feedItemStatus("status").notNull().default("unseen"),
    seenAt: timestamp("seen_at", { withTimezone: true }),
    readAt: timestamp("read_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    idempotencyKey: text("idempotency_key"),
    ...timestamps,
  },
  (t) => [
    index("feed_items_recipient_created_idx").on(t.recipientKey, t.createdAt),
    index("feed_items_recipient_status_idx").on(t.recipientKey, t.status),
    index("feed_items_contact_idx").on(t.contactId),
    // NULLs distinct (Postgres default) — unkeyed items never collide.
    uniqueIndex("feed_items_idempotency_key_idx").on(t.idempotencyKey),
  ],
);
