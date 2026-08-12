import { sql } from "drizzle-orm";
import { index, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { cloud, timestamps } from "./_shared";
import { environments } from "./environments";
import { organizations } from "./organizations";

/**
 * THE DEED to a sending domain — who, in the shared AWS account, is allowed to
 * touch `acme.com`.
 *
 * SES email identities are ACCOUNT-scoped and Hogsend Cloud deliberately runs
 * one AWS account for the whole fleet, so `GetEmailIdentity` answers for every
 * tenant's domains at once and the identity register cannot say whose domain
 * this is. Something else has to, and this table is it: an explicit, queryable
 * claim, taken under a unique index BEFORE the identity is created.
 *
 * It replaces an earlier deed — "does this ENVIRONMENT hold a DKIM key for the
 * domain" — which shipped two customer-facing regressions, and both of them are
 * why each column below is shaped the way it is:
 *
 *  - **the claim is scoped to the ORGANIZATION, never the environment.** The
 *    DKIM key lives in one environment's `provider_keys` row, so asking the key
 *    "is this yours" answered NO for the same customer's second environment: a
 *    tenant who verified `acme.com` in production could never use it from
 *    staging. The tenant is the ORG, so the deed is the org's.
 *  - **the claim OUTLIVES the environment that took it.** Deleting an
 *    environment cascades its `provider_keys` row away, which destroyed the old
 *    deed while the SES identity survived in AWS — leaving a domain no
 *    environment on earth could ever claim again, including the customer's own.
 *    So {@link sendingDomains.environmentId} is `SET NULL`, not `CASCADE`: it
 *    records which environment first registered the domain, for support and
 *    observability, and it is deliberately NOT part of the ownership predicate.
 *    Releasing the claim is an explicit act of teardown (`deprovisionSesTenant`,
 *    which deletes the SES identity in the same breath), never a side effect of
 *    a row disappearing.
 *
 * The row is SOFT-deleted (`released_at`) rather than removed, so the history of
 * who held a domain survives a release — the question an abuse investigation
 * asks is "who was sending from this six months ago", and a hard delete answers
 * it with silence.
 */
export const sendingDomains = cloud.table(
  "sending_domains",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /**
     * The claimant. THE ownership predicate: a caller owns the domain when a
     * live claim exists whose `organization_id` is theirs.
     *
     * CASCADE, because a tenant that no longer exists cannot hold a domain and
     * a claim outliving its org would lock the name away from everyone.
     */
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /**
     * Which environment first registered the domain. Support and observability
     * ONLY — never consulted by the ownership check.
     *
     * NULLABLE and `SET NULL` on purpose, and this is the whole fix for the
     * second regression: the claim MUST survive its environment being deleted,
     * because the SES identity does. A `CASCADE` here would rebuild the exact
     * bug this table replaces.
     */
    environmentId: uuid("environment_id").references(() => environments.id, {
      onDelete: "set null",
    }),
    /** Normalized through `lib/sending-domains.ts#normalizeDomain`. */
    domain: text("domain").notNull(),
    /** The SES region the identity lives in — `us-east-1` / `eu-west-1`. */
    awsRegion: text("aws_region").notNull(),
    /**
     * When the claim was given up and the SES identity deleted. NULL = live.
     *
     * Set by teardown only, and ALWAYS after the identity is gone: a claim
     * released while its identity survives is a domain nobody can ever take
     * again.
     */
    releasedAt: timestamp("released_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    // ONE live claim per domain, GLOBALLY — not per organization.
    //
    // Global because an SES email identity is unique across the whole AWS
    // account: two orgs cannot both hold `acme.com`, so a per-org unique index
    // would let the second org take a claim it could never turn into an
    // identity, and then pass the ownership check for somebody else's domain.
    //
    // PARTIAL (`WHERE released_at IS NULL`) so a released domain returns to the
    // pool while its history stays on the table. This index is also the upsert
    // arbiter `claimSendingDomain` races through, so its predicate is repeated
    // verbatim there (`targetWhere`) — Postgres matches the arbiter by
    // predicate, not by name.
    uniqueIndex("sending_domains_domain_live_unique_idx")
      .on(table.domain)
      .where(sql`released_at IS NULL`),
    // The release path's access: every live claim an organization holds, read
    // when its last SES tenancy is torn down.
    index("sending_domains_organization_id_idx").on(table.organizationId),
  ],
);
