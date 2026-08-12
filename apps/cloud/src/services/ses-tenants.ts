import { randomBytes } from "node:crypto";
import { and, count, eq, ne } from "drizzle-orm";
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
  type SesEventType,
  type SesRegion,
  type SesReputationPolicy,
  type SesSuppressionReason,
} from "../ses/types";
import { sesEventTopicArn } from "../sns/topics";
import type { SubstrateRegion } from "../substrate/types";
import { type CloudWriter, writeAudit } from "./audit";
import { NotFoundError } from "./errors";
import { insertRelayToken } from "./relay-tokens";
import type { SendingDomainClaim } from "./sending-domain-claims";
import {
  listSendingDomainClaims,
  releaseSendingDomains,
} from "./sending-domain-claims";
import {
  resolveSesAvailability,
  type SesAvailability,
} from "./ses-availability";

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
 *  - **Teardown is real and ordered.** Associations first, then the tenant,
 *    then the configuration set, then the credentials. A leaked configuration
 *    set keeps publishing events for an environment that no longer exists.
 *    See {@link SES_DEPROVISION_STEPS} for why the order is what it is, which
 *    is NOT the reason it first appears to be.
 *  - **The relay token's plaintext exists exactly once**, returned by the call
 *    that mints it and never stored. `set-env` is the only consumer, and it
 *    runs in the very next pipeline step.
 *  - **No AWS credentials is a MODE, not a failure.** The factory yields the
 *    Fake, provisioning completes exactly as it does today, and the row is
 *    marked `available: false`. The same is true of a SANDBOX account, and of
 *    an account that cannot be read: `available` means "this account can
 *    SEND", never "we hold credentials" (`services/ses-availability.ts`), and
 *    the refusal always carries a recorded reason.
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
  // CONDITIONAL — the only one. Skipped when the region has no configured SNS
  // topic (`CLOUD_SES_SNS_TOPIC_ARN_*`), which is the supported no-AWS default.
  // The returned `steps` therefore reports what actually ran, rather than
  // claiming a destination that was never attached.
  "put-event-destination",
  "associate-configuration-set",
  "put-suppression-scope",
  "set-reputation-policy",
  // Row, relay token and audit in ONE transaction: an environment with an SES
  // tenant but no relay token is one nothing could ever send through.
  "persist",
] as const;

/**
 * The SES event types this stack's configuration sets publish (PRD 05, PRD 18).
 *
 * FIVE. `OPEN` and `CLICK` are absent because opens and clicks are FIRST-PARTY
 * and sovereign — the engine's own `/v1/t/o` and `/v1/t/c` are the single
 * source of truth, and subscribing to SES's would give the engine two
 * disagreeing answers to one question. `SEND` is absent because the relay
 * really does already know what it sent.
 *
 * **`REJECT` is here, and the comment above used to claim it was absent for
 * the same reason as `SEND`. That was half true and the wrong half.** A
 * `Reject` arrives AFTER the send call returned a message id: SES accepted the
 * message, detected a virus in it, and stopped — "doesn't attempt to deliver
 * it to the recipient's mail server", in AWS's words. No bounce follows, no
 * delivery follows, nothing follows. Without this subscription that
 * `email_sends` row never reaches a terminal state, so the customer sees a
 * send that looks fine and a recipient who got nothing, with no explanation
 * anywhere. It is the one outcome the relay CANNOT infer from its own call.
 *
 * Adding it is safe on a re-drive: `putEventDestination` is a PUT (see the
 * seam's create-then-update note), so a configuration set provisioned with the
 * old four converges to five rather than duplicating or failing.
 */
export const SES_PUBLISHED_EVENT_TYPES: readonly SesEventType[] = [
  "DELIVERY",
  "BOUNCE",
  "COMPLAINT",
  "DELIVERY_DELAY",
  "REJECT",
];

/** The event destination's name on the configuration set. One per set. */
export const SES_EVENT_DESTINATION_NAME = "hogsend-events";

export type SesProvisionStep = (typeof SES_PROVISION_STEPS)[number];

/**
 * Teardown, in dependency order.
 *
 * **Read this before "simplifying" the order.** An earlier version of this
 * comment claimed SES refuses to delete a resource that is still associated
 * with a tenant. **That is not true, and it was never true.** `DeleteTenant`'s
 * API reference says the opposite outright: "When you delete a tenant, its
 * associations with resources are removed, but the resources themselves are not
 * deleted", and its only documented errors are BadRequest, NotFound and
 * TooManyRequests. There is no association conflict to preempt.
 *
 * We disassociate first anyway, for two reasons that survive that correction:
 * an undocumented refusal is far cheaper to preempt than to discover during a
 * customer teardown, and an explicit disassociation is one call whose absence
 * would otherwise be indistinguishable from a silent no-op.
 *
 * So the order test pins a CHOSEN order, not an AWS invariant. It still earns
 * its place by catching an accidental reorder, but do not build a precondition
 * check on top of a constraint AWS does not have.
 *
 * The genuinely load-bearing part is that a configuration set left behind keeps
 * publishing events for an environment that no longer exists.
 *
 * There is deliberately NO `delete-event-destination` step. A destination is a
 * child of its configuration set, so `DeleteConfigurationSet` takes it with it;
 * a separate delete would be one more call that can only ever fail with
 * `not_found`.
 */
export const SES_DEPROVISION_STEPS = [
  "disassociate-configuration-set",
  "delete-tenant",
  "delete-configuration-set",
  // CONDITIONAL — runs only when this was the organization's LAST SES tenancy.
  // See `releaseSendingDomainsIfLastTenancy` for why that is the rule, and why
  // the identity is deleted BEFORE the claim is released.
  "release-sending-domains",
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
   * Whether Hogsend Email may be activated for this environment, and — when it
   * may not — the reason, for the provision record. `summary.available` is the
   * same verdict as stored on the row; this carries the WHY, which the row
   * does not.
   */
  availability: SesAvailability;
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
  /**
   * The SNS topic the configuration set publishes events to. Defaults to the
   * region's configured topic; `null` skips the event destination entirely.
   */
  snsTopicArn?: string | null;
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

  // ---- put-event-destination ----------------------------------------------
  // Without this the configuration set publishes NOTHING, so no bounce or
  // complaint ever reaches the tenant's engine: suppression never happens and
  // `email_sends` never reaches a terminal status. The verb is a PUT (the seam
  // does the create-then-update dance AWS has no single operation for), so a
  // re-drive restates it.
  //
  // Skipped — not failed — when the region has no configured topic. A control
  // plane with no AWS account is the supported default, and there is nothing to
  // publish to; the provision still completes and `steps` says so.
  const snsTopicArn = deps.snsTopicArn ?? sesEventTopicArn(region);
  if (snsTopicArn) {
    await ses.putEventDestination({
      configurationSetName,
      eventDestinationName: SES_EVENT_DESTINATION_NAME,
      snsTopicArn,
      eventTypes: [...SES_PUBLISHED_EVENT_TYPES],
      enabled: true,
    });
    steps.push("put-event-destination");
  }

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
  // "Can this account SEND?", not "do we hold credentials" — the whole reason
  // `resolveSesAvailability` exists. Cached per region, so this is free on all
  // but the first provision after a boot, and it fails CLOSED: a sandbox
  // account, a paused account, or an account we could not read all leave
  // Hogsend Email inactive, with the reason recorded below.
  const availability = await resolveSesAvailability(ses);
  const available = availability.available;
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
        // WHY, whenever the answer is no. Without it `available: false` reads
        // like the step silently did nothing, and the operator's next move
        // (chase the credentials? chase AWS support?) is a guess.
        unavailableReason: availability.reason,
        unavailableDetail: available ? null : availability.detail,
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
    availability,
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

  // REFUSE to tear down a REAL tenant with a FAKE client.
  //
  // The two facts that make this necessary: every step below tolerates
  // `not_found` (correctly — a deleted resource is the goal), and the Fake
  // answers `not_found` for everything it never minted. Together they mean a
  // row provisioned against real AWS, torn down after the control plane lost
  // its credentials, would report a clean success, delete the row, and leak the
  // real tenant and configuration set PERMANENTLY — with the only record of
  // their existence now gone, so nothing could reconcile them later. That is
  // precisely the leak this teardown exists to prevent, arrived at by a route
  // that looks like success at every step.
  //
  // Parking the destroy is the right failure: the pipeline re-drives, and the
  // resources are still there when the credentials come back.
  if (row.available && ses.id !== AWS_SES_ID) {
    throw new Error(
      `refusing to deprovision SES tenant ${row.tenantName}: it was provisioned against AWS, but the active client is "${ses.id}". Restore CLOUD_AWS_ACCESS_KEY_ID/CLOUD_AWS_SECRET_ACCESS_KEY and re-drive — tearing down with the fake would report success and leak the real tenant and configuration set.`,
    );
  }

  const steps: SesDeprovisionStep[] = [];

  // ---- disassociate-configuration-set -------------------------------------
  // BEFORE the tenant, by choice rather than by an AWS rule — see
  // `SES_DEPROVISION_STEPS`. Neither AWS nor the Fake refuses a delete on
  // account of an association, so the end state cannot prove the order and the
  // tests assert it from the call log instead.
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

  // ---- release-sending-domains --------------------------------------------
  const released = await releaseSendingDomainsIfLastTenancy({
    db,
    ses,
    environmentId,
    awsRegion: row.awsRegion,
  });
  if (released !== null) steps.push("release-sending-domains");

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
        // What the organization gave back, and null when it kept everything
        // because another environment still holds a tenancy. Names only.
        releasedDomains: released?.map((claim) => claim.domain) ?? null,
      },
    });
  });
  steps.push("delete-relay-token", "forget");

  return { found: true, steps };
}

/**
 * Give the organization's sending domains back to the pool — SES identity
 * first, claim second — but ONLY when this teardown removes its LAST tenancy.
 *
 * **The rule, and why it is the organization rather than the environment.** The
 * claim is org-scoped, so releasing it on ENVIRONMENT deletion would hand a
 * domain back while another environment of the same customer is still sending
 * from it: the identity would be deleted underneath a live production
 * environment, and the next org to type that domain would take it. So a claim
 * survives while ANY environment of the org still has an SES tenancy, and is
 * released when the last one goes. (The org itself going takes the rows with
 * it: `sending_domains.organization_id` cascades.)
 *
 * **The ORDER inside is load-bearing.** The identity is deleted BEFORE the
 * claim is released, never after. A crash in between leaves a claim whose
 * identity is already gone — recoverable, because the same org re-creates it
 * and a re-driven teardown releases it. The opposite order leaves an identity
 * with no claim, which nobody can ever take again: exactly the permanent
 * refusal this whole change exists to remove.
 *
 * Returns the released claims, or `null` when the org keeps them.
 */
async function releaseSendingDomainsIfLastTenancy(input: {
  db: CloudDb;
  ses: SesClient;
  environmentId: string;
  awsRegion: string;
}): Promise<SendingDomainClaim[] | null> {
  const { db, ses, environmentId } = input;

  const [target] = await db
    .select({ organizationId: environments.organizationId })
    .from(environments)
    .where(eq(environments.id, environmentId))
    .limit(1);
  if (!target) throw new NotFoundError("Environment", environmentId);

  // Every OTHER environment of this org that still holds a tenancy. This row is
  // still present (it is deleted in the transaction below), so it is excluded
  // explicitly rather than by counting after the fact.
  const [siblings] = await db
    .select({ total: count() })
    .from(sesTenants)
    .innerJoin(environments, eq(environments.id, sesTenants.environmentId))
    .where(
      and(
        eq(environments.organizationId, target.organizationId),
        ne(sesTenants.environmentId, environmentId),
      ),
    );
  if ((siblings?.total ?? 0) > 0) return null;

  const claims = await listSendingDomainClaims(db, target.organizationId);
  for (const claim of claims) {
    // Cannot happen: every environment of an org inherits the org's fixed
    // region, and `aws_region` is derived from it. If it ever does, PARK the
    // teardown rather than delete in the wrong region — a `not_found` there
    // looks like success and would release a claim whose identity is still
    // live, locking the domain away from everyone forever.
    if (claim.awsRegion !== input.awsRegion) {
      throw new Error(
        `refusing to release sending domain "${claim.domain}": its identity is in ${claim.awsRegion} but this teardown addresses ${input.awsRegion}. Deleting in the wrong region would answer not_found and leak the identity.`,
      );
    }
    // Absent is the goal, so an identity somebody already removed is success.
    await tolerate(["not_found"], () =>
      ses.deleteIdentity({ identity: claim.domain }),
    );
  }

  // Only now — after every identity is provably gone.
  return releaseSendingDomains({
    writer: db,
    organizationId: target.organizationId,
  });
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
