import {
  index,
  integer,
  jsonb,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { cloud, timestamps } from "./_shared";
import { cloudRegionEnum, stackStatusEnum } from "./enums";
import { environments } from "./environments";
import { organizations } from "./organizations";

/**
 * The provisioned runtime behind one environment — 1:1, enforced by the unique
 * index on `environment_id`.
 *
 * `status` is written ONLY by `StackService.transition()` (PRD 02 task 4); the
 * legal-edge table lives there, not in the database, because a transition also
 * writes an audit row and that pairing must be atomic in one place.
 */
export const stacks = cloud.table(
  "stacks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // Denormalised from the environment purely for query ergonomics: every
    // tenant-scoped read filters by org, and this keeps stack listings a single
    // index scan instead of a join.
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    status: stackStatusEnum("status").default("requested").notNull(),
    /** Last failure message when `status = 'error'`. */
    lastError: text("last_error"),
    /** Retry attempts since the last success; reset on `running`. */
    retryCount: integer("retry_count").default(0).notNull(),
    /**
     * OPAQUE substrate handles (service ids, project ids, …). Deliberately
     * jsonb and deliberately unshaped: no Railway-specific columns leak into
     * the control-plane schema, so a second substrate needs no migration.
     */
    substrateRefs: jsonb("substrate_refs")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    /** Engine version locked at publish time. */
    engineVersion: text("engine_version"),
    /** Hatchet tenant/namespace this stack's workers run under. */
    hatchetNamespace: text("hatchet_namespace"),
    /** Database name on the cell's shared cluster. */
    dbName: text("db_name"),
    /**
     * The tenant DSN issued by `TenantDbService.create`, ENCRYPTED at rest
     * (`lib/crypto.ts`, same envelope as provider keys).
     *
     * It is persisted at FIRST create because a repeated create reports
     * `alreadyExists` with NO dsn — the password is unknowable a second time.
     * Without this column a replayed provisioning step would have to rotate the
     * credential out from under a stack that is already running on it.
     */
    dbDsnEncrypted: text("db_dsn_encrypted"),
    /**
     * The stack's Hatchet API token, ENCRYPTED at rest. Hatchet tokens are
     * write-once (unreadable after minting), so the persisted copy is the ONLY
     * one; its presence is also what makes the mint step skippable on a replay.
     */
    hatchetTokenEncrypted: text("hatchet_token_encrypted"),
    /**
     * Control-plane-generated secrets for this stack, as an ENCRYPTED JSON
     * object — today `{ betterAuthSecret }`.
     *
     * One column rather than one per secret: these are values the control plane
     * MINTS (not credentials a tenant supplies), they are always written and
     * read together by `set-env`, and a new one must not need a migration. The
     * decrypted shape is validated in `pipeline/provision.ts`.
     */
    stackSecretsEncrypted: text("stack_secrets_encrypted"),
    region: cloudRegionEnum("region").notNull(),
    ...timestamps,
  },
  (table) => [
    // The 1:1 law: one stack per environment, ever.
    uniqueIndex("stacks_environment_id_unique_idx").on(table.environmentId),
    index("stacks_organization_id_idx").on(table.organizationId),
    // Reconciler sweeps: "everything stuck in provisioning / error".
    index("stacks_status_idx").on(table.status),
  ],
);
