import { boolean, index, integer, text, uuid } from "drizzle-orm/pg-core";
import { cloud, timestamps } from "./_shared";
import { cloudRegionEnum } from "./enums";

/**
 * A shared-infrastructure cell: one Postgres cluster + one Hatchet engine in one
 * region, hosting many shared-plan tenants. Seeded by ops, read at signup (to
 * pick a landing cell) and by the provisioner (to reach the substrate).
 *
 * The stated exception to the "every tenant table carries organization_id"
 * rule — a cell is infrastructure, not tenant data.
 */
export const cells = cloud.table(
  "cells",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** Ops-facing handle, e.g. "us-1". */
    name: text("name").notNull().unique(),
    region: cloudRegionEnum("region").notNull(),
    /**
     * Superuser DSN for the cell's shared Postgres cluster, ENCRYPTED at rest
     * (AES-256-GCM, PRD 02 task 2). Never read raw outside the provisioner.
     */
    sharedClusterDsn: text("shared_cluster_dsn").notNull(),
    /** gRPC/HTTP address of the cell's Hatchet engine. */
    sharedHatchetUrl: text("shared_hatchet_url").notNull(),
    /** Ops kill-switch: false drains the cell from new-tenant placement. */
    accepting: boolean("accepting").default(true).notNull(),
    /** Placement ceiling; the placer counts live tenants against it. */
    maxTenants: integer("max_tenants").default(100).notNull(),
    ...timestamps,
  },
  (table) => [
    // The placement query: "an accepting cell in this region".
    index("cells_region_accepting_idx").on(table.region, table.accepting),
  ],
);
