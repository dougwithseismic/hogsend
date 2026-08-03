import { index, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { cloud, timestamps } from "./_shared";
import { environmentKindEnum } from "./enums";
import { organizations } from "./organizations";

/**
 * A named deployment target inside an organization (production / staging /
 * test). One environment owns at most one stack (see `stacks`).
 *
 * "Exactly one production per org" is a SERVICE-layer rule (PRD 02 task 3),
 * deliberately not a constraint here.
 */
export const environments = cloud.table(
  "environments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Tenant-chosen handle, unique within the org. */
    name: text("name").notNull(),
    kind: environmentKindEnum("kind").notNull(),
    ...timestamps,
  },
  (table) => [
    // Names are addressable per tenant: acme/production, acme/staging.
    uniqueIndex("environments_org_name_unique_idx").on(
      table.organizationId,
      table.name,
    ),
    // The dashboard's list query.
    index("environments_organization_id_idx").on(table.organizationId),
  ],
);
