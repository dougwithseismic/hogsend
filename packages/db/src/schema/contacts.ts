import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./_shared.js";

export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id"),
    externalId: text("external_id").notNull().unique(),
    email: text("email"),
    /**
     * Opportunistic IANA-timezone cache (e.g. "America/New_York"). Populated
     * best-effort when a tz is resolved from PostHog person props. PostHog and
     * `properties` jsonb remain authoritative sources — this column sits below
     * them in the resolution precedence, so nothing is blocked on it.
     */
    timezone: text("timezone"),
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
  (table) => [index("contacts_email_idx").on(table.email)],
);
