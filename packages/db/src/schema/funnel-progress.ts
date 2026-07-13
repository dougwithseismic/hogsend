import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { contacts } from "./contacts.js";

/**
 * Per-contact event-funnel projection (docs/attribution-impact-plan.md
 * §3.3) — the thin sibling of `deals` for funnels whose stages are EVENT
 * matchers instead of CRM claims. One row per (contact, funnel, stage),
 * written FIRST-REACH-ONLY at ingest (the unique index absorbs replays and
 * repeat events), so both progression counts ("how many reached activated")
 * and velocity ("median time signed_up → activated") read straight off it.
 *
 * `event_id` deliberately has NO FK — events may be retained on a different
 * schedule than the projection (same stance as attribution_credits).
 */
export const funnelProgress = pgTable(
  "funnel_progress",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    /** The contact's canonical event key at reach time. */
    userKey: text("user_key").notNull(),
    /** `defineFunnel` meta.id (code-first — no FK). */
    funnelId: text("funnel_id").notNull(),
    stage: text("stage").notNull(),
    /** The stage's ladder index (monotonic rank), denormalized. */
    stageRank: integer("stage_rank").notNull(),
    /** When the stage was FIRST reached (the matching event's time). */
    reachedAt: timestamp("reached_at", { withTimezone: true }).notNull(),
    /** The reaching `user_events` row id (no FK — retention differs). */
    eventId: uuid("event_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("funnel_progress_contact_funnel_stage_idx").on(
      table.contactId,
      table.funnelId,
      table.stage,
    ),
    index("funnel_progress_funnel_rank_idx").on(
      table.funnelId,
      table.stageRank,
    ),
    index("funnel_progress_funnel_reached_idx").on(
      table.funnelId,
      table.reachedAt,
    ),
  ],
);
