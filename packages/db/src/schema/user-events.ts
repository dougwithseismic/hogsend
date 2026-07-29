import { isNotNull, sql } from "drizzle-orm";
import {
  char,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const userEvents = pgTable(
  "user_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id"),
    // PRD 05 F5: the key AS OBSERVED AT WRITE TIME — frozen, never rewritten.
    // Ownership rides contact_id; reads scope by it (bySubject).
    userId: text("user_id").notNull(),
    // Owning contact, dual-written by the engine (PRD 04); no FK by design —
    // see PRD 04 D1. Indexed partially below.
    // PRD 07: NULL is LEGAL and permanent here, not a gap to migrate away. It
    // means the writer had no contact row to point at: `lib/ingestion.ts`
    // refused to mint one (`resolveContactNoCreate`), e.g. an anon-only
    // POST /v1/events on a publishable key. Such a row is a string-keyed
    // subject and reads scope it by `user_id` (the bySubject else-arm).
    contactId: uuid("contact_id"),
    event: text("event").notNull(),
    properties: jsonb("properties").$type<Record<string, unknown>>(),
    // Group association map captured at event time (groupType → groupKey), e.g.
    // { company: "acme.com" }. Feeds group membership + group-level analytics.
    // Nullable — most events carry no group context.
    groups: jsonb("groups").$type<Record<string, string>>(),
    // The event's own monetary worth (a deal value on `deal.sold`, an order
    // total on `order.completed`) — first-class so revenue is SQL-aggregable,
    // never buried in the properties bag. Negative values are legal (refunds).
    value: numeric("value", { precision: 14, scale: 2, mode: "number" }),
    // ISO-4217 alpha code, uppercased at ingest. Nullable independently of
    // `value` for backfill tolerance, but the ingest paths always set both.
    currency: char("currency", { length: 3 }),
    // Where the event entered the pipeline: a webhook source id ("posthog",
    // "stripe", …), "api", "studio", a connector id, "journey", etc. Nullable —
    // events ingested before this column existed have no recorded origin.
    source: text("source"),
    idempotencyKey: text("idempotency_key"),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // Partial index serving revenue-per-contact rollups without bloating the
    // hot path (valued events are a small fraction of the table).
    index("user_events_valued_user_idx")
      .on(table.userId, table.occurredAt)
      .where(isNotNull(table.value)),
    // The group-revenue twin of the index above: a GIN over the `groups`
    // association map, partial to the VALUED + GROUPED slice (a small fraction
    // of a small fraction), so the admin group rollups' containment lookups
    // (`groups @> '{"company":"acme.com"}'::jsonb`) never scan the event spine.
    // `jsonb_path_ops` — containment is the only operator these queries use, and
    // it indexes smaller/faster than the default `jsonb_ops`.
    index("user_events_valued_groups_idx")
      .using("gin", table.groups.op("jsonb_path_ops"))
      .where(sql`(${isNotNull(table.value)} and ${isNotNull(table.groups)})`),
    index("user_events_user_id_idx").on(table.userId),
    index("user_events_event_idx").on(table.event),
    index("user_events_source_idx").on(table.source),
    index("user_events_occurred_at_idx").on(table.occurredAt),
    index("user_events_user_event_occurred_idx").on(
      table.userId,
      table.event,
      table.occurredAt,
    ),
    uniqueIndex("user_events_idempotency_key_idx").on(table.idempotencyKey),
    // PRD 04 D2 — PARTIAL btree on the owning contact. Partial because the
    // column is 100% NULL when the migration runs (so the build is a heap scan
    // with zero index writes, the cheapest possible version of an expensive
    // statement), it stays small through the additive era, and it permanently
    // excludes the rows that legitimately have no contact. It still serves the
    // `WHERE contact_id = $1` probes the merge repoint issues: the planner can
    // prove `contact_id = $1` implies `contact_id IS NOT NULL`, so the
    // predicate is not a barrier (asserted by an EXPLAIN test, not assumed).
    index("user_events_contact_id_idx")
      .on(table.contactId)
      .where(sql`contact_id IS NOT NULL`),
  ],
);
