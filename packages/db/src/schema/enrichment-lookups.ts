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
import { contacts } from "./contacts.js";
import {
  enrichmentLookupKindEnum,
  enrichmentLookupStatusEnum,
} from "./enums.js";

/**
 * Durable ledger of every enrichment lookup — the version-independent Layer-2
 * backstop for refinement, architecturally identical to `email_sends` for the
 * tracked mailer. One row per (provider, lookup_kind, lookup_key): the unique
 * index below carries three jobs at once — TTL cache, negative cache, and
 * exactly-once. No soft delete: this is an operational ledger, not contact
 * data.
 */
export const enrichmentLookups = pgTable(
  "enrichment_lookups",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // Enrichment provider id from the registry (e.g. "apollo"). Plain text —
    // the id space is open (BYO provider), so no enum.
    provider: text("provider").notNull(),
    lookupKind: enrichmentLookupKindEnum("lookup_kind").notNull(),
    // Normalized lookup subject (an email address or a domain).
    lookupKey: text("lookup_key").notNull(),
    // "found" | "not_found" | "error". A `not_found` row is a PAID negative
    // result and suppresses re-spend until it expires; an `error` row is NOT a
    // paid result and must not suppress a retry.
    status: enrichmentLookupStatusEnum("status").notNull(),
    // ON DELETE set null deliberately: deleting a contact must not erase
    // spend history. Nullable for the same reason.
    contactId: uuid("contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    refinedAt: timestamp("refined_at", { withTimezone: true }).notNull(),
    // Materialised on write (`refined_at + ENRICHMENT_TTL_DAYS`) rather than
    // computed at read time, so an existing row's TTL is stable if the env var
    // later changes.
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    // Provider's verbatim response, for debugging. Nullable so a deployment
    // can null it out for storage/privacy reasons without a schema change.
    raw: jsonb("raw").$type<Record<string, unknown>>(),
    // The NORMALIZED canonical trait patch the paid answer produced — the
    // engine's `flattenTraits` output, verbatim. `raw` is vendor-shaped and cannot be
    // re-flattened engine-side without the provider, so a cache HIT for a
    // DIFFERENT contact than the one that paid (the shared-domain case) has no
    // way to land the answer it already owns unless the patch itself is stored.
    // Null on rows written before this column existed, and on `error` rows.
    traits: jsonb("traits").$type<Record<string, unknown>>(),
    // ---- Spend accounting (the budget cap counts LOOKUPS, not rows) --------
    // The row is one-per-key by design (TTL + negative cache + exactly-once),
    // so a `force` refresh UPDATES it rather than inserting. Counting rows
    // therefore counts distinct SUBJECTS, not vendor calls, and a force loop on
    // one key spends without ever moving the count. These two columns make the
    // count exact: `spend_count` is the number of provider calls recorded for
    // this key inside `spend_window`, and it RESETS to 1 whenever a call lands
    // in a new window — so last month's attempts can never bleed into this
    // month's budget.
    spendWindow: timestamp("spend_window", { withTimezone: true }),
    spendCount: integer("spend_count").notNull().default(0),
    // Last provider throw for this key. An error must not clobber a live cached
    // row (status/expires_at/raw stay put), but the attempt still left the
    // building and must be visible + counted: an outage across an
    // already-refined base is exactly when the cap has to hold.
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    // TTL cache + negative cache + exactly-once, all in one arbiter. NOT
    // partial — there is no soft delete on this table.
    uniqueIndex("enrichment_lookups_provider_key_unique_idx").on(
      table.provider,
      table.lookupKind,
      table.lookupKey,
    ),
    // Serves reporting/forensics over the ledger by time.
    index("enrichment_lookups_refined_at_idx").on(table.refinedAt),
    // Serves the budget-period SUM (equality filter on spend_window).
    index("enrichment_lookups_spend_window_idx").on(table.spendWindow),
    index("enrichment_lookups_contact_id_idx").on(table.contactId),
  ],
);
