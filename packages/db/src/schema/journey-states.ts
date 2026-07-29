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
import { journeyStatusEnum } from "./enums.js";

export const journeyStates = pgTable(
  "journey_states",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id"),
    // PRD 05 F5: the key AS OBSERVED AT WRITE TIME — frozen, never rewritten.
    // Ownership rides contact_id; reads scope by it (bySubject).
    userId: text("user_id").notNull(),
    userEmail: text("user_email").notNull(),
    // Owning contact, dual-written by the engine (PRD 04). NOTHING reads this
    // column yet; no FK by design — see PRD 04 D1. Indexed partially below.
    contactId: uuid("contact_id"),
    journeyId: text("journey_id").notNull(),
    currentNodeId: text("current_node_id").notNull(),
    status: journeyStatusEnum("status").notNull().default("active"),
    hatchetRunId: text("hatchet_run_id"),
    /**
     * Impact experiments (Decision A): content fingerprint of the journey
     * DEFINITION this row was created under — stamped at INSERT on both
     * the enrollment and held_out paths, NEVER updated (a replay/resume
     * recovers the row and must keep the entry-time version). Nullable:
     * rows predating the feature form the "unversioned" cohort.
     */
    journeyVersionHash: text("journey_version_hash"),
    /** Author label (JourneyMeta.version / blueprint v{n}). Display-only. */
    journeyVersionLabel: text("journey_version_label"),
    context: jsonb("context").$type<Record<string, unknown>>().default({}),
    errorMessage: text("error_message"),
    entryCount: integer("entry_count").notNull().default(1),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    exitedAt: timestamp("exited_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    // Absolute deadline for a `ctx.waitForEvent({ where })` re-arm loop. The
    // single-`sleepFor` durability trick does NOT extend to a multi-iteration
    // re-arm (each iteration arms a fresh SleepCondition), so the deadline is
    // persisted here once (read-first / set-once) and re-read on Hatchet
    // replay-from-top — without it the wait would extend on every replay. NULL
    // when the row is not in a where-filtered wait; cleared on resolve.
    waitDeadline: timestamp("wait_deadline", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    // EXACTLY ONE LIVE enrollment per (user, journey) — a PARTIAL unique index
    // scoped to non-terminal rows (status IN ('active','waiting')), mirroring
    // uq_user_bucket_active. The old FULL (user,journey,status) index broke
    // `unlimited` journeys: the 2nd completion produced a second
    // (user,journey,'completed') row and threw 23505. Terminal rows
    // (completed/failed/exited) sit OUTSIDE the predicate, so an unlimited journey
    // can complete any number of times (one row per completion — every reader
    // counts rows, never the dead entry_count column). The predicate matches the
    // enrollment guard's live set (define-journey.ts:133-142) and checkExits, and
    // is a STRICTLY tighter backstop than the old index (it also blocks a
    // concurrent active+waiting double-insert). Generated SQL: `CREATE UNIQUE
    // INDEX uq_user_journey_active ON journey_states (user_id, journey_id)
    // WHERE status IN ('active','waiting')`.
    //
    // organizationId deliberately OMITTED — same NULLS-DISTINCT caveat as
    // uq_user_bucket_active. When multi-tenancy lands and the column is non-null,
    // add it to the PREDICATE (not the indexed columns).
    uniqueIndex("uq_user_journey_active")
      .on(table.userId, table.journeyId)
      .where(sql`status IN ('active', 'waiting')`),
    // PRD 05 T3 — the CONTACT-scoped twin of uq_user_journey_active. Adoption
    // stamps `contact_id` WITHOUT rewriting `user_id`, so a row keyed by an anon
    // id and a row keyed by an external id can both become the same contact and
    // both be live; the string index above permits that and a `contact_id` read
    // would then see a double enrollment. This index is what forbids it.
    //
    // `contact_id IS NOT NULL` in the predicate is LOAD-BEARING, not decoration.
    // Contactless enrollments are a permanent, supported state (the engine
    // refuses to mint contacts on observation), so anonymous visitors MUST stay
    // outside this index — their one-live-row rule keeps coming from
    // uq_user_journey_active, which stays. Postgres' default NULLS DISTINCT
    // would already exempt them; the predicate says so out loud and keeps the
    // index to identified rows only. A NULLS NOT DISTINCT variant would be
    // catastrophic: every anonymous visitor collapsed into one row per journey.
    //
    // NOTHING uses this as an ON CONFLICT arbiter. drizzle can only target
    // columns, and a bare (contact_id, journey_id) arbiter would never fire for
    // the NULL population — an anonymous re-trigger would insert a second row
    // and die on the retained string index. `insertEnrollment` keeps the string
    // arbiter and CATCHES this index's 23505, mapping it to the same
    // `already_active` outcome.
    uniqueIndex("uq_contact_journey_active")
      .on(table.contactId, table.journeyId)
      .where(sql`contact_id IS NOT NULL AND status IN ('active', 'waiting')`),
    index("journey_states_status_idx").on(table.status),
    index("journey_states_hatchet_run_idx").on(table.hatchetRunId),
    index("journey_states_user_id_idx").on(table.userId),
    index("journey_states_journey_id_status_idx").on(
      table.journeyId,
      table.status,
    ),
    // Time-windowed activity counts (GET /v1/health) range-scan on updatedAt —
    // without this the healthcheck seq-scans the whole table on every hit.
    index("journey_states_updated_at_idx").on(table.updatedAt),
    // PRD 04 D2 — PARTIAL btree on the owning contact; see the twin on
    // user_events for why the predicate is not a barrier to `contact_id = $1`.
    index("journey_states_contact_id_idx")
      .on(table.contactId)
      .where(sql`contact_id IS NOT NULL`),
  ],
);
