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
import { conversions } from "./conversions.js";

/**
 * The attribution credit LEDGER (docs/revenue-attribution-plan.md §6.1) —
 * one row per (conversion, model, touchpoint), written once at conversion
 * time with EVERY model's allocation. Persisting all models up front means
 * switching the reporting model is a WHERE clause, not a re-derivation of
 * history (touchpoint windows, ladders, and event retention all drift —
 * the ledger doesn't).
 */
export const attributionCredits = pgTable(
  "attribution_credits",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conversionId: uuid("conversion_id")
      .notNull()
      .references(() => conversions.id, { onDelete: "cascade" }),
    /** Attribution model id (@hogsend/attribution ATTRIBUTION_MODELS). */
    model: text("model").notNull(),
    /** The credited touchpoint's `user_events` row id (no FK — events may
     * be retained on a different schedule than the ledger). */
    touchpointEventId: uuid("touchpoint_event_id").notNull(),
    /** Denormalized touchpoint facts so reporting never joins user_events. */
    touchpointEvent: text("touchpoint_event").notNull(),
    channel: text("channel").notNull(),
    touchpointAt: timestamp("touchpoint_at", { withTimezone: true }).notNull(),
    /** Fraction of the conversion (one model's rows sum to 1). */
    weight: numeric("weight", {
      precision: 9,
      scale: 8,
      mode: "number",
    }).notNull(),
    /** weight × the conversion's value, in its currency (null = valueless). */
    value: numeric("value", { precision: 14, scale: 2, mode: "number" }),
    currency: char("currency", { length: 3 }),
    /**
     * Attribution scope (docs/attribution-impact-plan.md §1.3) — denormalized
     * from the touch event's stamped properties (fallback: email_sends join
     * for events ingested before scope stamping). All nullable: a touch
     * outside any journey/campaign carries none. "This journey attributed £X
     * under time-decay" is a WHERE clause over these columns.
     */
    journeyId: text("journey_id"),
    campaignId: uuid("campaign_id"),
    templateKey: text("template_key"),
    funnelId: text("funnel_id"),
    /** The conversion's occurredAt (denormalized for windowed reporting). */
    convertedAt: timestamp("converted_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("attribution_credits_conv_model_touch_idx").on(
      table.conversionId,
      table.model,
      table.touchpointEventId,
    ),
    index("attribution_credits_model_converted_idx").on(
      table.model,
      table.convertedAt,
    ),
    index("attribution_credits_channel_idx").on(table.channel),
    index("attribution_credits_journey_idx").on(table.journeyId),
    index("attribution_credits_campaign_idx").on(table.campaignId),
  ],
);
