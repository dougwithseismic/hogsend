import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_shared.js";

/**
 * Operator-owned / standalone tracked links — the managed surface behind the
 * Studio "Links" view and any non-email channel (Discord, SMS, share links). A
 * `links` row is the durable, named identity of a tracked link; the click
 * counter + per-hit `link_clicks` live in `tracked_links` (which points back
 * here via `link_id`). Email's own per-send rewritten links do NOT create a
 * `links` row (they keep `tracked_links.link_id` NULL) — email stays a separate
 * consumer of the same click spine.
 */
export const links = pgTable(
  "links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    originalUrl: text("original_url").notNull(),
    // "personal" = single-recipient, identity-bearing (carries `distinctId`, may
    // mint a SINGLE-USE `hs_t`); "public" = shareable, NEVER carries a person
    // token (campaign/UTM attribution only). Default "public" — the safe default.
    type: text("type").notNull().default("public"),
    // Operator-facing name (Studio list).
    label: text("label"),
    // UTM-style campaign grouping for public links.
    campaign: text("campaign"),
    // Originating channel: "studio" | "discord" | "sms" | … (open string).
    source: text("source").notNull(),
    // The canonical contact key a click should stitch the visitor's anon session
    // into — set ONLY for personal links; NULL for public/broadcast (a shareable
    // link must never carry a person).
    distinctId: text("distinct_id"),
    // The admin actor who minted it (mirrors api_keys.createdBy).
    createdBy: text("created_by"),
    // Soft-delete: archive (not hard-delete) so historical `link_clicks` survive
    // (the `tracked_links.link_id` FK is ON DELETE set null as a backstop).
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("links_source_idx").on(table.source),
    index("links_campaign_idx").on(table.campaign),
    index("links_created_at_idx").on(table.createdAt),
  ],
);
