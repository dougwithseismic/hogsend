import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { CloudDb } from "../db";
import { db as defaultDb } from "../db";
import {
  environments,
  organizations,
  relayTokens,
  sesTenants,
} from "../db/schema";
import { decryptSecretPayload, encryptSecretPayload } from "../lib/crypto";
import { AWS_SES_ID } from "../ses/aws";
import type { SesClient } from "../ses/contract";
import { resolveSesRegion } from "../ses/contract";
import { getSesClient } from "../ses/index";
import { sesConfigurationSetName, sesTenantName } from "../ses/names";
import {
  SesError,
  type SesErrorKind,
  type SesRegion,
  type SesReputationPolicy,
  type SesSuppressionReason,
} from "../ses/types";
import type { SubstrateRegion } from "../substrate/types";
import { type CloudWriter, writeAudit } from "./audit";
import { NotFoundError } from "./errors";
import { insertRelayToken } from "./relay-tokens";

/**
 * One SES tenant per Cloud environment (DECISIONS §3.2), minted here and torn
 * down here.
 *
 * The laws, in the order they matter:
 *
 *  - **`SuppressionScope: TENANT`, addressed by TENANT NAME.** Without it every
 *    tenant shares the ACCOUNT suppression list, so one customer's hard bounce
 *    silently suppresses that address for every other customer — a
 *    deliverability bug and a cross-tenant information leak at once, with no
 *    symptom until it leaks. It is `PutTenantSuppressionAttributes`, not the
 *    similarly-named `PutConfigurationSetSuppressionOptions`, which cannot set
 *    tenant scope at all.
 *  - **Every step is idempotent and converges.** The provisioning pipeline
 *    re-drives after a transient failure, so each call here either tolerates
 *    "already there" or is a PUT. A partial run leaves nothing that a re-drive
 *    turns into a duplicate.
 *  - **A new tenant starts on reputation policy `NONE`** — observe before
 *    enforcing. A re-drive RE-ASSERTS the policy the row records rather than
 *    resetting it, so it can never walk back a PRD 08 promotion.
 *  - **Teardown is real and ordered.** Associations first (SES refuses to
 *    delete an associated resource), then the tenant, then the configuration
 *    set, then the credentials. A leaked configuration set keeps publishing
 *    events for an environment that no longer exists.
 *  - **The relay token's plaintext exists exactly once**, returned by the call
 *    that mints it and never stored. `set-env` is the only consumer, and it
 *    runs in the very next pipeline step.
 *  - **No AWS credentials is a MODE, not a failure.** The factory yields the
 *    Fake, provisioning completes exactly as it does today, and the row is
 *    marked `available: false`.
 */

/** The actor recorded when a caller does not name one. */
const DEFAULT_ACTOR = "provisioner";

/**
 * BOTH reasons, always. A tenant list tracking only bounces would still leak
 * every complaint onto the account list, which is the same cross-tenant failure
 * wearing a different hat.
 */
export const SES_SUPPRESSED_REASONS: readonly SesSuppressionReason[] = [
  "BOUNCE",
  "COMPLAINT",
];

/** Where every new tenant starts. Promotion is PRD 08's, never provisioning's. */
export const SES_INITIAL_REPUTATION_POLICY: SesReputationPolicy = "NONE";

/** 256 bits of CSPRNG entropy, the same floor as the relay token. */
const WEBHOOK_SECRET_BYTES = 32;

/**
 * The provisioning steps, in order. Exported so a test can drive a failure at
 * every one of them and prove the re-drive converges — the property that makes
 * a parked stack resumable rather than restartable.
 */
export const SES_PROVISION_STEPS = [
  "create-tenant",
  "create-configuration-set",
  "associate-configuration-set",
  "put-suppression-scope",
  "set-reputation-policy",
  // Row, relay token and audit in ONE transaction: an environment with an SES
  // tenant but no relay token is one nothing could ever send through.
  "persist",
] as const;

export type SesProvisionStep = (typeof SES_PROVISION_STEPS)[number];

/**
 * Teardown, in dependency order. The order is the whole content of this list:
 * SES refuses to delete a resource that is still associated with a tenant, and
 * a configuration set left behind keeps publishing events for an environment
 * that no longer exists.
 */
export const SES_DEPROVISION_STEPS = [
  "disassociate-configuration-set",
  "delete-tenant",
  "delete-configuration-set",
  "delete-relay-token",
  "forget",
] as const;

export type SesDeprovisionStep = (typeof SES_DEPROVISION_STEPS)[number];

/** Everything a dashboard (or PRD 08) may see. Never the webhook secret. */
export interface SesTenantSummary {
  environmentId: string;
  tenantName: string;
  tenantArn: string;
  configurationSetName: string;
  region: SubstrateRegion;
  awsRegion: SesRegion;
  reputationPolicy: SesReputationPolicy;
  /** False when the Fake minted it — Hogsend Email is not really live here. */
  available: boolean;
  provisionedAt: Date;
}

export interface ProvisionSesTenantResult {
  summary: SesTenantSummary;
  /**
   * The relay token PLAINTEXT. The only copy that will ever exist: the caller
   * injects it into the stack's environment and drops it.
   */
  relayToken: string;
  /** The HMAC secret the control plane signs instance deliveries with. */
  webhookSecret: string;
  /** True when this run REPLACED a live token (a re-drive), false on a mint. */
  relayTokenRotated: boolean;
  steps: SesProvisionStep[];
}

export interface DeprovisionSesTenantResult {
  /** False when there was nothing to tear down — an ordinary answer. */
  found: boolean;
  steps: SesDeprovisionStep[];
}

export interface SesTenantDeps {
  db?: CloudDb;
  /** Defaults to the process-wide client for the environment's region. */
  ses?: SesClient;
}

const targetSchema = z.object({
  environmentId: z.uuid(),
  actor: z.string().min(1).max(200).optional(),
});

type SesTenantRow = typeof sesTenants.$inferSelect;

/**
 * Mint (or converge) this environment's SES tenancy and its relay credentials.
 *
 * Safe to call repeatedly. Every SES call below is idempotent, and the two
 * database writes are an upsert on `(environment_id)`, so a run that died at
 * any step re-drives to the same end state without duplicating a resource.
 */
export async function provisionSesTenant(
  input: { environmentId: string; actor?: string },
  deps: SesTenantDeps = {},
): Promise<ProvisionSesTenantResult> {
  const { environmentId, actor } = targetSchema.parse(input);
  const db = deps.db ?? defaultDb;

  const target = await loadTarget(db, environmentId);
  const region = target.region;
  const awsRegion = resolveSesRegion(region);
  const ses = deps.ses ?? getSesClient(region);
  const tenantName = sesTenantName(environmentId);
  const configurationSetName = sesConfigurationSetName(environmentId);
  const steps: SesProvisionStep[] = [];

  // ---- create-tenant ------------------------------------------------------
  // The one create verb that is idempotent by name on this seam: an existing
  // tenant is RETURNED. It also carries the ARN, which is the only place the
  // account id comes from — we never guess one.
  const tenant = await ses.createTenant({ tenantName });
  steps.push("create-tenant");

  // ---- create-configuration-set -------------------------------------------
  // Mirrors AWS and reports `already_exists`; a re-drive treats that as done.
  await tolerate(["already_exists"], () =>
    ses.createConfigurationSet({ configurationSetName }),
  );
  steps.push("create-configuration-set");

  // ---- associate-configuration-set ----------------------------------------
  // Set membership: the seam promises re-asserting an association is a no-op,
  // in BOTH implementations, so a re-drive adds nothing.
  const configurationSetArn = deriveConfigurationSetArn(
    tenant.arn,
    configurationSetName,
  );
  await ses.associateResource({
    tenantName,
    resourceArn: configurationSetArn,
  });
  steps.push("associate-configuration-set");

  // ---- put-suppression-scope ----------------------------------------------
  // THE line of this PRD (see the module note). A PUT, so a re-drive restates
  // it; both reasons every time, because an omitted `reasons` is a RESET.
  await ses.putSuppressionScope({
    tenantName,
    scope: "TENANT",
    reasons: [...SES_SUPPRESSED_REASONS],
  });
  steps.push("put-suppression-scope");

  // ---- set-reputation-policy ----------------------------------------------
  // The policy the ROW records, defaulting to `NONE` for a tenant that has none
  // yet. Re-asserting rather than resetting is what stops a re-drive from
  // walking back a PRD 08 promotion; it also repairs a tenant that was
  // re-created out of band and came back on AWS's default.
  const existing = await findByEnvironment(db, environmentId);
  const reputationPolicy =
    existing?.reputationPolicy ?? SES_INITIAL_REPUTATION_POLICY;
  await ses.setReputationPolicy({ tenantName, policy: reputationPolicy });
  steps.push("set-reputation-policy");

  // ---- persist ------------------------------------------------------------
  const available = ses.id === AWS_SES_ID;
  const persisted = await db.transaction(async (tx) => {
    // Locks the environment's organization, which serialises two concurrent
    // provisions of one environment behind each other rather than letting both
    // mint a token and one of them win silently.
    const organizationId = await lockEnvironmentOrganization(tx, environmentId);
    const current = await findByEnvironment(tx, environmentId);
    // Stable across re-drives: the instance verifies control-plane webhook
    // deliveries with this, and rotating it on every re-drive would break
    // deliveries for no reason. The relay token cannot be stable the same way
    // — only its hash is stored, so there is nothing to replay.
    const webhookSecret = current
      ? decryptSecretPayload<string>(current.webhookSecretEncrypted)
      : generateWebhookSecret();

    const [liveToken] = await tx
      .select({ id: relayTokens.id })
      .from(relayTokens)
      .where(eq(relayTokens.environmentId, environmentId))
      .limit(1);
    const minted = await insertRelayToken(tx, { environmentId });

    const values = {
      environmentId,
      tenantName,
      tenantArn: tenant.arn,
      configurationSetName,
      region,
      awsRegion,
      // The row's OWN value wins over the one read before the SES calls: a PRD
      // 08 promotion that landed in that window is an intent we must not
      // overwrite, and the next converge re-asserts it to SES. Recording the
      // lower policy instead would turn a race into a silent demotion.
      reputationPolicy: current?.reputationPolicy ?? reputationPolicy,
      webhookSecretEncrypted: encryptSecretPayload(webhookSecret),
      available,
      provisionedAt: new Date(),
    };
    const [row] = await tx
      .insert(sesTenants)
      .values(values)
      .onConflictDoUpdate({
        target: sesTenants.environmentId,
        // `reputation_policy` rides along because it is the value READ from
        // this row a moment ago — a re-drive restates it, never resets it.
        set: { ...values, updatedAt: new Date() },
      })
      .returning();
    if (!row) {
      throw new Error(
        `Failed to record the SES tenant for environment ${environmentId}`,
      );
    }

    await writeAudit(tx, {
      actor: actor ?? DEFAULT_ACTOR,
      organizationId,
      action: current ? "ses_tenant.reprovisioned" : "ses_tenant.provisioned",
      subject: row.id,
      // Names and regions only. Never the token, never the webhook secret.
      detail: {
        environmentId,
        tenantName,
        configurationSetName,
        awsRegion,
        reputationPolicy,
        available,
      },
    });
    await writeAudit(tx, {
      actor: actor ?? DEFAULT_ACTOR,
      organizationId,
      action: liveToken ? "relay_token.rotated" : "relay_token.minted",
      subject: minted.row.id,
      detail: { environmentId, reason: "provision" },
    });

    return {
      row,
      webhookSecret,
      relayToken: minted.token,
      relayTokenRotated: liveToken !== undefined,
    };
  });
  steps.push("persist");

  return {
    summary: toSummary(persisted.row),
    relayToken: persisted.relayToken,
    webhookSecret: persisted.webhookSecret,
    relayTokenRotated: persisted.relayTokenRotated,
    steps,
  };
}

/**
 * Tear this environment's SES tenancy down, in dependency order, tolerating any
 * piece of it already being gone.
 *
 * Every step's goal is an ABSENCE, so "not found" is success rather than an
 * error to retry: waiting does not make a deleted resource reappear.
 */
export async function deprovisionSesTenant(
  input: { environmentId: string; actor?: string },
  deps: SesTenantDeps = {},
): Promise<DeprovisionSesTenantResult> {
  const { environmentId, actor } = targetSchema.parse(input);
  const db = deps.db ?? defaultDb;

  const row = await findByEnvironment(db, environmentId);
  // Nothing was ever provisioned (or a previous teardown finished). Not an
  // error — and deliberately no SES call, so a second destroy is free.
  if (!row) return { found: false, steps: [] };

  // The region the tenant was minted IN, from the row — never the
  // organization's current one. A tenant is region-scoped and does not
  // replicate, so addressing the wrong region would silently delete nothing.
  const ses = deps.ses ?? getSesClient(row.region);
  const steps: SesDeprovisionStep[] = [];

  // ---- disassociate-configuration-set -------------------------------------
  // BEFORE the tenant: SES refuses to delete a resource that is still
  // associated, and the Fake does not model that — which is exactly why the
  // order is asserted from the call log in the tests rather than from state.
  await tolerate(["not_found"], () =>
    ses.disassociateResource({
      tenantName: row.tenantName,
      resourceArn: deriveConfigurationSetArn(
        row.tenantArn,
        row.configurationSetName,
      ),
    }),
  );
  steps.push("disassociate-configuration-set");

  // ---- delete-tenant ------------------------------------------------------
  await tolerate(["not_found"], () =>
    ses.deleteTenant({ tenantName: row.tenantName }),
  );
  steps.push("delete-tenant");

  // ---- delete-configuration-set -------------------------------------------
  await tolerate(["not_found"], () =>
    ses.deleteConfigurationSet({
      configurationSetName: row.configurationSetName,
    }),
  );
  steps.push("delete-configuration-set");

  // ---- delete-relay-token + forget ----------------------------------------
  // One transaction: a row that outlived its credential would describe a
  // tenancy nothing can reach, and a credential that outlived its row would be
  // a live token for a tenant that no longer exists.
  await db.transaction(async (tx) => {
    const organizationId = await lockEnvironmentOrganization(tx, environmentId);
    await tx
      .delete(relayTokens)
      .where(eq(relayTokens.environmentId, environmentId));
    await tx.delete(sesTenants).where(eq(sesTenants.id, row.id));
    await writeAudit(tx, {
      actor: actor ?? DEFAULT_ACTOR,
      organizationId,
      action: "ses_tenant.deprovisioned",
      subject: row.id,
      detail: {
        environmentId,
        tenantName: row.tenantName,
        configurationSetName: row.configurationSetName,
        awsRegion: row.awsRegion,
      },
    });
  });
  steps.push("delete-relay-token", "forget");

  return { found: true, steps };
}

/**
 * This environment's SES tenancy, or null. The read surface behind PRD 06's
 * last acceptance criterion; it never carries the webhook secret.
 */
export async function getSesTenant(
  input: { environmentId: string },
  deps: { db?: CloudDb } = {},
): Promise<SesTenantSummary | null> {
  const { environmentId } = targetSchema.parse(input);
  const row = await findByEnvironment(deps.db ?? defaultDb, environmentId);
  return row ? toSummary(row) : null;
}

/**
 * The secret the control plane signs this environment's webhook deliveries
 * with (PRD 05), or null when the environment has no SES tenancy.
 *
 * Separate from `getSesTenant` on purpose: a summary travels to dashboards and
 * audit details, and a signing key must never ride along with one.
 */
export async function getSesWebhookSecret(
  input: { environmentId: string },
  deps: { db?: CloudDb } = {},
): Promise<string | null> {
  const { environmentId } = targetSchema.parse(input);
  const row = await findByEnvironment(deps.db ?? defaultDb, environmentId);
  return row ? decryptSecretPayload<string>(row.webhookSecretEncrypted) : null;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function generateWebhookSecret(): string {
  return randomBytes(WEBHOOK_SECRET_BYTES).toString("base64url");
}

/**
 * Run `operation`, swallowing exactly the `SesError` kinds that mean "already
 * in the desired state". Every other error propagates: a throttled call is not
 * a converged one, and treating it as success is how a half-provisioned tenant
 * gets recorded as finished.
 */
async function tolerate(
  kinds: SesErrorKind[],
  operation: () => Promise<void>,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof SesError && kinds.includes(error.kind)) return;
    throw error;
  }
}

/**
 * The configuration set's ARN, derived from the TENANT's.
 *
 * The account id (and partition) are read off an ARN AWS gave us rather than
 * assembled from configuration, because the control plane is never told which
 * account its credentials belong to — and an ARN built around a guessed account
 * id fails as `not_found` at association time, which reads like a missing
 * resource rather than like the misconfiguration it is.
 */
function deriveConfigurationSetArn(
  tenantArn: string,
  configurationSetName: string,
): string {
  const [prefix, partition, service, region, account] = tenantArn.split(":");
  if (prefix !== "arn" || !partition || !service || !region || !account) {
    throw new SesError(
      `cannot derive a configuration-set ARN: tenant ARN ${JSON.stringify(
        tenantArn,
      )} is not an ARN`,
      { kind: "invalid" },
    );
  }
  return `arn:${partition}:${service}:${region}:${account}:configuration-set/${configurationSetName}`;
}

function toSummary(row: SesTenantRow): SesTenantSummary {
  return {
    environmentId: row.environmentId,
    tenantName: row.tenantName,
    tenantArn: row.tenantArn,
    configurationSetName: row.configurationSetName,
    region: row.region,
    // Stored as text (it is AWS's vocabulary, not ours) and narrowed on the
    // way out; the column is only ever written from `resolveSesRegion`.
    awsRegion: row.awsRegion as SesRegion,
    reputationPolicy: row.reputationPolicy,
    available: row.available,
    provisionedAt: row.provisionedAt,
  };
}

async function findByEnvironment(
  writer: CloudWriter,
  environmentId: string,
): Promise<SesTenantRow | undefined> {
  const [row] = await writer
    .select()
    .from(sesTenants)
    .where(eq(sesTenants.environmentId, environmentId))
    .limit(1);
  return row;
}

/**
 * The environment's organization and the REGION its tenant belongs in.
 *
 * The region comes from the ORGANIZATION, exactly as the relay reads it
 * (`lib/email-relay.ts`): the relay picks its SES client that way on every
 * send, so provisioning that derived the region any other way could mint a
 * tenant in a region no send will ever address.
 */
async function loadTarget(
  db: CloudDb,
  environmentId: string,
): Promise<{ organizationId: string; region: SubstrateRegion }> {
  const [row] = await db
    .select({
      organizationId: environments.organizationId,
      region: organizations.region,
    })
    .from(environments)
    .innerJoin(organizations, eq(organizations.id, environments.organizationId))
    .where(eq(environments.id, environmentId))
    .limit(1);
  if (!row) throw new NotFoundError("Environment", environmentId);
  return row;
}

/** The environment's organization, with the row locked — see `relay-tokens`. */
async function lockEnvironmentOrganization(
  writer: CloudWriter,
  environmentId: string,
): Promise<string> {
  const [row] = await writer
    .select({ organizationId: environments.organizationId })
    .from(environments)
    .where(eq(environments.id, environmentId))
    .limit(1)
    .for("update");
  if (!row) throw new NotFoundError("Environment", environmentId);
  return row.organizationId;
}
