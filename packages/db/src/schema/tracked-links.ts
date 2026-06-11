import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./_shared.js";
import { emailSends } from "./email-sends.js";

export const trackedLinks = pgTable(
  "tracked_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    emailSendId: uuid("email_send_id")
      .notNull()
      .references(() => emailSends.id, { onDelete: "cascade" }),
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
  (table) => [index("tracked_links_email_send_id_idx").on(table.emailSendId)],
);
