import {
  char,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { contacts } from "./contacts.js";
import { userEvents } from "./user-events.js";

/**
 * Fired conversion instances — one
 * row per (definition, triggering event). Definitions are code-first
 * (`defineConversion`); this table is the durable record the attribution
 * engine credits and conversion destinations dispatch from. The unique
 * (definition_id, event_id) pair makes evaluation idempotent across ingest
 * retries.
 */
export const conversions = pgTable(
  "conversions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** `defineConversion` meta.id (code-first — no FK). */
    definitionId: text("definition_id").notNull(),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    /** The contact's canonical event key at fire time. */
    userKey: text("user_key").notNull(),
    /** The triggering `user_events` row. */
    eventId: uuid("event_id")
      .notNull()
      .references(() => userEvents.id, { onDelete: "cascade" }),
    value: numeric("value", { precision: 14, scale: 2, mode: "number" }),
    currency: char("currency", { length: 3 }),
    /**
     * The definition's DECLARED scope (`ConversionMeta.scope`), persisted so
     * admin/Studio can filter fired conversions by journey/campaign without
     * reading code (docs/attribution-impact-plan.md §1.4). Descriptive only —
     * never an evaluation gate. Distinct from the ledger's per-touchpoint
     * scope columns (which record which journey/campaign TOUCHED the path).
     */
    scopeJourneyId: text("scope_journey_id"),
    scopeCampaignId: text("scope_campaign_id"),
    /** The triggering event's time (conversion time for attribution windows). */
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("conversions_definition_event_idx").on(
      table.definitionId,
      table.eventId,
    ),
    index("conversions_contact_idx").on(table.contactId),
    index("conversions_definition_occurred_idx").on(
      table.definitionId,
      table.occurredAt,
    ),
  ],
);
