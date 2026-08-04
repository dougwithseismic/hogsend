import { index, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { cloud, timestamps } from "./_shared";
import { environments } from "./environments";
import { organizations } from "./organizations";

/**
 * A name that points at one environment's instance.
 *
 * This table is the arbiter of hostname uniqueness for the whole control plane,
 * which is why `hostname` is globally unique rather than unique per tenant: two
 * organizations cannot both answer at `acme.hogsend.com`, and the database is
 * the only place that can hold that line under concurrent signups.
 *
 * It also holds the two vendor handles teardown needs. Both are opaque — the
 * control plane stores them and hands them back, and never parses one — for the
 * same reason `stacks.substrate_refs` is unshaped: a second DNS provider or a
 * second substrate must not need a migration. Storing them at all is the point:
 * destroy deletes exactly the record it created, rather than searching a zone
 * by name and hoping it found the right row.
 */
export const hostnames = cloud.table(
  "hostnames",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // Denormalised from the environment, like `stacks.organization_id`, so a
    // tenant-scoped listing is one index scan rather than a join.
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    /** The fully-qualified name, e.g. `acme.hogsend.com`. Lowercase. */
    hostname: text("hostname").notNull(),
    /**
     * `managed` — minted by us inside our own zone, one per environment, and
     * the instance's identity. `custom` — supplied by the tenant, verified
     * against their DNS, and always additional.
     *
     * The distinction decides what may be deleted: a tenant may remove a custom
     * hostname, and may never remove the managed one, because `API_PUBLIC_URL`
     * is built from it and every tracked link already sent resolves through it.
     */
    kind: text("kind").notNull().default("managed"),
    /** The DNS provider's record id. Null for a custom hostname, whose records
     * live in the tenant's own zone and are not ours to delete. */
    dnsRecordId: text("dns_record_id"),
    /** The substrate's custom-domain id, for detaching on teardown. */
    substrateDomainId: text("substrate_domain_id"),
    ...timestamps,
  },
  (table) => [
    // THE uniqueness guarantee. Global, not per-tenant: DNS is a flat namespace
    // and two tenants claiming one name is a collision no scoping can resolve.
    uniqueIndex("hostnames_hostname_unique_idx").on(table.hostname),
    // "what does this environment answer on" — the detail page's read, and
    // teardown's.
    index("hostnames_environment_id_idx").on(table.environmentId),
    index("hostnames_organization_id_idx").on(table.organizationId),
  ],
);
