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
import { bucketMembershipStatusEnum } from "./enums.js";

export const bucketMemberships = pgTable(
  "bucket_memberships",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // multi-tenant insurance (nullable today, NOT in the unique key — see note)
    organizationId: text("organization_id"),
    // logical join to contacts.externalId — NO FK (matches userEvents /
    // journeyStates; membership rows can predate a contacts row).
    // PRD 05 F5: the key AS OBSERVED AT WRITE TIME — frozen, never rewritten.
    // Ownership rides contact_id; reads scope by it (bySubject).
    userId: text("user_id").notNull(),
    userEmail: text("user_email"), // denormalized so emitted events carry it
    // Owning contact, dual-written by the engine (PRD 04). NOTHING reads this
    // column yet; no FK by design — see PRD 04 D1. Indexed partially below.
    contactId: uuid("contact_id"),
    bucketId: text("bucket_id").notNull(),
    status: bucketMembershipStatusEnum("status").notNull().default("active"),
    enteredAt: timestamp("entered_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    leftAt: timestamp("left_at", { withTimezone: true }),
    // membership epoch / armed deadline for time-based + fastExpiry buckets
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    // unconditional membership TTL deadline (enteredAt + meta.maxDwell). Set once
    // on join, never mutated. The reconcile cron force-leaves rows past it
    // REGARDLESS of criteria — kept separate from expiresAt, which is the
    // criteria-window / minDwell-defer arming epoch (overloaded meaning).
    maxDwellAt: timestamp("max_dwell_at", { withTimezone: true }),
    lastEvaluatedAt: timestamp("last_evaluated_at", { withTimezone: true }),
    entryCount: integer("entry_count").notNull().default(1),
    source: text("source"), // "event" | "reconcile" | "backfill" | "manual"
    context: jsonb("context").$type<Record<string, unknown>>().default({}),
    // Per-membership dwell bookkeeping. JSON map keyed by dwellLabel → ISO of
    // last dwell fire for THIS continuous membership. A re-join is a NEW row
    // (empty map). NULL/{} = never fired.
    dwellState: jsonb("dwell_state")
      .$type<Record<string, string>>()
      .default({}),
    // Historical dwell anchor for backfilled members (NULL for live joins → use
    // enteredAt). The dwell gate reads coalesce(dwellAnchorAt, enteredAt) so the
    // dwell clock starts at the derived historical instant, not the backfill
    // instant. Kept separate from enteredAt (which minDwell/maxDwellAt/criteria
    // cron key on) — strictly additive.
    dwellAnchorAt: timestamp("dwell_anchor_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    // EXACTLY ONE ACTIVE membership per (user, bucket), with any number of
    // historical "left" rows coexisting. This is a PARTIAL unique index scoped
    // to active, non-deleted rows — NOT a plain (userId,bucketId,status) unique
    // index. Buckets are re-entrant: a user oscillates join → leave → join →
    // leave forever, so a plain unique key on (userId,bucketId,status) would
    // throw on the SECOND "left" row (two rows share (user,bucket,'left')). The
    // journeyStates model does NOT transfer here because journey terminal states
    // are reached once; bucket "left" is reached repeatedly. The generated SQL
    // is `CREATE UNIQUE INDEX uq_user_bucket_active ON bucket_memberships
    // (user_id, bucket_id) WHERE status = 'active' AND deleted_at IS NULL`.
    // organizationId deliberately OMITTED — same NULLS-DISTINCT caveat as
    // uq_user_journey_active (journey-states.ts:34-40). Add it to the predicate
    // only when multi-tenancy lands and the column is non-null.
    uniqueIndex("uq_user_bucket_active")
      .on(table.userId, table.bucketId)
      .where(sql`status = 'active' AND deleted_at IS NULL`),
    // PRD 05 T3 — the CONTACT-scoped twin of uq_user_bucket_active. Adoption
    // stamps `contact_id` WITHOUT rewriting `user_id`, so two string keys can
    // both become the same contact and hold two ACTIVE rows for one bucket; the
    // string index above permits that and a `contact_id` read would then see a
    // double membership. Same partial predicate, same re-entrancy: "left" rows
    // sit outside it, so oscillating join → leave → join stays legal.
    //
    // `contact_id IS NOT NULL` in the predicate is LOAD-BEARING: contactless
    // memberships are permanent and supported (`bucket_memberships` is
    // text-keyed with no contact FK — a contactless subject is a first-class
    // member), so anonymous visitors must stay outside this index and keep
    // getting their uniqueness from uq_user_bucket_active.
    //
    // All three writers (`checkBucketMembership`, `bucket-reconcile`,
    // `bucket-backfill`) insert with an ARBITER-LESS `ON CONFLICT DO NOTHING`,
    // which absorbs a violation of EITHER index into the same "lost the race /
    // already a member" branch. Do not narrow those to a column target.
    uniqueIndex("uq_contact_bucket_active")
      .on(table.contactId, table.bucketId)
      .where(
        sql`contact_id IS NOT NULL AND status = 'active' AND deleted_at IS NULL`,
      ),
    index("bucket_memberships_bucket_id_status_idx").on(
      table.bucketId,
      table.status,
    ), // list members / size metrics
    index("bucket_memberships_user_id_idx").on(table.userId), // a user's buckets
    index("bucket_memberships_last_evaluated_idx").on(table.lastEvaluatedAt),
    index("bucket_memberships_expires_at_idx").on(table.expiresAt),
    // the cron TTL sweep: active rows past their max_dwell_at
    index("bucket_memberships_max_dwell_at_idx").on(table.maxDwellAt),
    // dwell continuous-member scan anchor
    index("bucket_memberships_dwell_idx").on(
      table.bucketId,
      table.status,
      table.enteredAt,
    ),
    // keyset member-access pagination (ordered by id)
    index("bucket_memberships_bucket_id_status_id_idx").on(
      table.bucketId,
      table.status,
      table.id,
    ),
    // every-dwell oldest-served-first ordering (§6.5)
    index("bucket_memberships_dwell_lastfired_idx").on(
      table.bucketId,
      table.status,
      table.lastEvaluatedAt,
    ),
    // PRD 04 D2 — PARTIAL btree on the owning contact; see the twin on
    // user_events for why the predicate is not a barrier to `contact_id = $1`.
    index("bucket_memberships_contact_id_idx")
      .on(table.contactId)
      .where(sql`contact_id IS NOT NULL`),
  ],
);
