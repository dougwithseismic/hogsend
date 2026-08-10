import {
  boolean,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { cloud, timestamps } from "./_shared";
import { cloudRegionEnum, sesReputationPolicyEnum } from "./enums";
import { environments } from "./environments";

/**
 * One environment's SES tenancy — the control plane's record of what it minted
 * inside our AWS account for this tenant (PRD 06).
 *
 * A table of its own rather than columns on `environments`, for the reason the
 * relay token got its own: this row exists only for an environment that has
 * been provisioned against SES, it is written by exactly one code path, and a
 * control plane with no AWS account never grows one. Hanging six nullable
 * columns off `environments` would make "is this environment on Hogsend Email"
 * a question about NULLs.
 *
 * Everything here is DERIVED and PINNED at provision time:
 *  - `tenant_name` / `configuration_set_name` come from `src/ses/names.ts`
 *    (DECISIONS §3.2) and are recorded rather than re-derived, so a rename
 *    would be visible as a mismatch instead of silently addressing a resource
 *    that does not exist;
 *  - `region` is the data-residency region the tenant was minted FOR and
 *    `aws_region` the SES region it was minted IN. Tenants are region-scoped
 *    and do not replicate (DECISIONS §3.3), so the AWS region is pinned for the
 *    tenant's whole life — teardown must address the region it was CREATED in,
 *    not whatever the organization's region column says today;
 *  - `tenant_arn` is stored because `CreateTenant` returns it only on the call
 *    that creates the tenant, and both reputation writes address a tenant by
 *    ARN. It also carries the account id, which is how the configuration-set
 *    ARN is derived without ever guessing one.
 */
export const sesTenants = cloud.table(
  "ses_tenants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    /** `env-<environmentId>` — opaque, stable, no customer string in it. */
    tenantName: text("tenant_name").notNull(),
    /** `arn:aws:ses:<region>:<account>:tenant/<name>`. */
    tenantArn: text("tenant_arn").notNull(),
    configurationSetName: text("configuration_set_name").notNull(),
    region: cloudRegionEnum("region").notNull(),
    /** The SES region, pinned. `us-east-1` / `eu-west-1`. */
    awsRegion: text("aws_region").notNull(),
    /**
     * What we last asked SES to enforce for this tenant. New tenants start on
     * `NONE` — observe before enforcing, AWS's own onboarding advice — and PRD
     * 08 owns every promotion from there. Provisioning RE-ASSERTS whatever this
     * column says rather than resetting it, so a re-drive can never walk a
     * promotion back.
     */
    reputationPolicy: sesReputationPolicyEnum("reputation_policy")
      .default("NONE")
      .notNull(),
    /**
     * The HMAC secret the control plane signs instance webhook deliveries with
     * (PRD 05) and `plugin-hogsend.verifyWebhook` checks. AES-256-GCM under
     * `CLOUD_ENCRYPTION_SECRET`, because unlike the relay token BOTH sides need
     * the same bytes — a one-way hash could not sign anything.
     */
    webhookSecretEncrypted: text("webhook_secret_encrypted").notNull(),
    /**
     * Whether a REAL AWS client minted this row, or the Fake did.
     *
     * A control plane with no credentials still provisions — it is the
     * supported default — and this is what marks the result unavailable rather
     * than failing the provision. It is per-row rather than read from the
     * environment because a control plane that LATER gains credentials must be
     * able to tell which environments still have no tenant in AWS.
     */
    available: boolean("available").default(false).notNull(),
    /**
     * When a provisioning run last converged. Distinct from `updated_at` on
     * purpose: PRD 08 writing a promoted `reputation_policy` moves that one and
     * must not move this one, which answers "when did we last reconcile this
     * tenant against AWS".
     */
    provisionedAt: timestamp("provisioned_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    ...timestamps,
  },
  // One tenancy per environment (DECISIONS §3.2), and the upsert arbiter a
  // re-driven provision converges through.
  (table) => [
    uniqueIndex("ses_tenants_environment_id_unique_idx").on(
      table.environmentId,
    ),
  ],
);
