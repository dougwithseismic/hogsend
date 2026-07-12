import {
  char,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { contacts } from "./contacts.js";

/**
 * The deals PROJECTION (docs/revenue-attribution-plan.md §4.2) — current
 * state materialized from `crm.stage_changed` events, the way `email_sends`
 * projects send activity. The event spine stays the append-only source of
 * truth; this table exists for reporting (pipeline totals, AOV,
 * time-to-close) and for the monotonic-stage rule that heals webhook+poll
 * double-detection and out-of-order delivery.
 */
export const deals = pgTable(
  "deals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** CRM provider id (`CrmProvider.meta.id`). */
    provider: text("provider").notNull(),
    /** Native deal/opportunity id in that CRM. */
    externalId: text("external_id").notNull(),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    /** Native pipeline id (multi-pipeline CRMs). */
    pipelineId: text("pipeline_id"),
    /** Native stage id of the last APPLIED change. */
    stageId: text("stage_id"),
    /**
     * Canonical stage (lead|contacted|survey_booked|quoted|sold|lost).
     * Advances monotonically by rank; `lost` is terminal-negative and never
     * overwrites `sold`.
     */
    canonicalStage: text("canonical_stage").notNull().default("lead"),
    /** Rank of `canonicalStage` (denormalized for the monotonic guard). */
    stageRank: integer("stage_rank").notNull().default(0),
    value: numeric("value", { precision: 14, scale: 2, mode: "number" }),
    currency: char("currency", { length: 3 }),
    /** First time the deal reached quoted / sold / lost. */
    quotedAt: timestamp("quoted_at", { withTimezone: true }),
    soldAt: timestamp("sold_at", { withTimezone: true }),
    lostAt: timestamp("lost_at", { withTimezone: true }),
    /** `occurredAt` of the last applied stage change (CRM time). */
    lastStageAt: timestamp("last_stage_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("deals_provider_external_idx").on(
      table.provider,
      table.externalId,
    ),
    index("deals_contact_idx").on(table.contactId),
    index("deals_stage_idx").on(table.canonicalStage),
  ],
);

/**
 * External-id alias map: which CRM record corresponds to which Hogsend
 * contact/deal. The canonical-key lesson from the research: own an internal
 * key, treat every external system's id as a mapped alias — identity survives
 * a CRM swap. Rows are minted on `pushLead` and on the first identity-bearing
 * inbound event.
 */
export const crmLinks = pgTable(
  "crm_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    provider: text("provider").notNull(),
    /** What the external id names: a CRM contact or a CRM deal. */
    kind: text("kind", { enum: ["contact", "deal"] }).notNull(),
    externalId: text("external_id").notNull(),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("crm_links_provider_kind_external_idx").on(
      table.provider,
      table.kind,
      table.externalId,
    ),
    index("crm_links_contact_idx").on(table.contactId),
  ],
);

/**
 * Reconciliation-poll cursors, one row per provider. `cursor` is
 * provider-defined (a timestamp, a page token); `lastError` surfaces a
 * failing poll without stopping the schedule.
 */
export const crmSyncCursors = pgTable("crm_sync_cursors", {
  provider: text("provider").primaryKey(),
  cursor: text("cursor"),
  lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
  lastError: jsonb("last_error").$type<{
    message: string;
    at: string;
  } | null>(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
