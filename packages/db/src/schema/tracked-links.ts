import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./_shared.js";
import { emailSends } from "./email-sends.js";
import { links } from "./links.js";

export const trackedLinks = pgTable(
  "tracked_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // NULLABLE since the identity-stitching minor: a tracked link no longer has
    // to belong to an email send. Broadcast/non-email links (Discord, referral,
    // ad-hoc `createTrackedLink`) carry NULL here. Email-link inserts keep
    // populating it; the FK + index are unchanged.
    emailSendId: uuid("email_send_id").references(() => emailSends.id, {
      onDelete: "cascade",
    }),
    // The managed `links` row this click-counter belongs to, when the link was
    // minted via `mintLink` (Studio / Discord / share links). NULL for email's
    // per-send rewritten links (they resolve identity from `email_sends`). ON
    // DELETE set null so archiving/removing a `links` row keeps the click spine.
    linkId: uuid("link_id").references(() => links.id, {
      onDelete: "set null",
    }),
    // Subject of a stitch-bearing NON-email link: the canonical contact key the
    // click should fold the visitor's anon session into. NULL for broadcast
    // links (Discord/referral default) — broadcast links are tracked for click
    // counts but carry no identity. Email links resolve their subject from the
    // `email_sends` row instead, so this stays NULL for them too.
    distinctId: text("distinct_id"),
    // Where the link originated: "email" | "discord" | "link". Drives the click
    // route's per-hit outbound emit (email links emit `email.clicked`; non-email
    // links emit `link.clicked`). NULL on legacy/email rows.
    source: text("source"),
    originalUrl: text("original_url").notNull(),
    clickCount: integer("click_count").notNull().default(0),
    // Semantic link metadata, lifted from the template's data-hs-* attributes
    // at send time. NULL for plain tracked links. `event` is the consumer event
    // name emitted at click time; `eventProperties` its scalar payload.
    event: text("event"),
    eventProperties: jsonb("event_properties").$type<Record<string, unknown>>(),
    // Set exactly once by the click route when the semantic event is emitted —
    // the per-link emit-once gate today, and the provisional-then-confirm
    // anchor later (a confirm flow can re-emit without a migration).
    semanticEmittedAt: timestamp("semantic_emitted_at", {
      withTimezone: true,
    }),
    ...timestamps,
  },
  (table) => [
    index("tracked_links_email_send_id_idx").on(table.emailSendId),
    index("tracked_links_link_id_idx").on(table.linkId),
    // A managed link has AT MOST ONE QR scan row (`source = 'qr'`), minted
    // lazily on first QR request. The partial unique index makes the lazy
    // select-or-insert race-safe: a concurrent double-mint loses cleanly.
    uniqueIndex("tracked_links_qr_per_link_unique")
      .on(table.linkId)
      .where(sql`${table.source} = 'qr'`),
  ],
);
