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
    /**
     * The cell's Hatchet engine address. When `shared_hatchet_api_url` is NULL
     * this is the single address BOTH endpoints are derived from (scheme-
     * carrying → HTTP base, bare `host:port` → gRPC). When it is set, this
     * column is the gRPC `host:port` only.
     */
    sharedHatchetUrl: text("shared_hatchet_url").notNull(),
    /**
     * The Hatchet HTTP API base (scheme-carrying) used for tenant token
     * minting, for a cell whose HTTP and gRPC endpoints are two different
     * addresses — as a Railway cell is, where the API sits behind
     * `https://<svc>.up.railway.app` and gRPC behind `<proxy>:<port>`. NULL
     * keeps the legacy single-address derivation from `shared_hatchet_url`.
     */
    sharedHatchetApiUrl: text("shared_hatchet_api_url"),
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
