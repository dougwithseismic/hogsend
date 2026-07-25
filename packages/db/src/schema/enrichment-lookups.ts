import {
  index,
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
    // Serves the budget-period COUNT (filter on refined_at).
    index("enrichment_lookups_refined_at_idx").on(table.refinedAt),
    index("enrichment_lookups_contact_id_idx").on(table.contactId),
  ],
);
