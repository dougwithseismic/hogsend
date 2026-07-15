import { sql } from "drizzle-orm";
import {
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./_shared.js";

/**
 * First-class account/team/company-level entity — Hogsend's sovereign answer to
 * PostHog group analytics. A group is identified by its (groupType, groupKey)
 * pair (e.g. type "company" + key "acme.com"), scoped to an optional tenant.
 * Contacts associate with groups via `group_memberships`; events carry a
 * `groups` association map (see user_events.groups).
 */
export const groups = pgTable(
  "groups",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // Multi-tenant scope (nullable today, exactly like contacts.organizationId).
    organizationId: text("organization_id"),
    // The group's kind, e.g. "company" / "team". Part of the natural key.
    groupType: text("group_type").notNull(),
    // The external id within a type — a domain, an account id, etc. Part of the
    // natural key.
    groupKey: text("group_key").notNull(),
    displayName: text("display_name"),
    properties: jsonb("properties")
      .$type<Record<string, unknown>>()
      .default({}),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    // Natural key: exactly one LIVE group per (type, key). Partial-unique scoped
    // to non-deleted rows (`WHERE deleted_at IS NULL`) so a soft-deleted row can
    // retain its stale key — identical idiom to the contacts identity indexes.
    // organizationId is deliberately OMITTED from the arbiter: it is nullable
    // and NULLs are DISTINCT in a unique index, so compositing it in would let
    // the default (org=NULL) case fork one company into duplicate rows. Like
    // contacts (external_id / email keyed alone), the key stands on its own;
    // org-scoped uniqueness is a deferred, system-wide multi-tenancy concern.
    // Also serves the live `(type, key)` resolve-by-natural-key lookup path, so
    // no separate plain index is needed.
    uniqueIndex("groups_type_key_unique_idx")
      .on(table.groupType, table.groupKey)
      .where(sql`deleted_at IS NULL`),
  ],
);
