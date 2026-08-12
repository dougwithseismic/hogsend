import { eq } from "drizzle-orm";
import { z } from "zod";
import type { CloudDb } from "../db";
import { db as defaultDb } from "../db";
import { environments } from "../db/schema";
import {
  getSubstrate,
  type StackRefs,
  type SubstrateEnvVars,
  type SubstrateProvider,
} from "../substrate";
import { writeAudit } from "./audit";
import { blocksSending, readEmailSendingStatus } from "./email-sending-status";
import { NotFoundError } from "./errors";
import {
  type FetchImpl,
  type ProviderKeyValidation,
  validateProviderKey,
} from "./key-validation";
import type { StackRow } from "./orgs";
import {
  buildProviderEnv,
  EMAIL_PROVIDER_IDS,
  emailDomainOf,
  PROVIDER_ENV_OWNED_NAMES,
  SENDER_IDENTITY_PROVIDER,
  type StoredProviderKey,
} from "./provider-env";
import {
  ProviderKeyService,
  type ProviderKeySummary,
  providerKeyPayloadSchema,
} from "./provider-keys";
import { StackService } from "./stacks";

/**
 * Store a tenant credential and make the running instance actually use it.
 *
 * The laws this module exists to hold (PRD 05):
 *
 *  - **Prove first, store second.** A key is live-probed before a single byte is
 *    written; an invalid key stores NOTHING — not a row, not an unverified
 *    placeholder, not the sender identity submitted beside it. One submission is
 *    one unit: if any part of it is refused, the environment is untouched.
 *  - **A paused tenant gets no BYO reroute (DECISIONS §6).** While the
 *    environment's sending status blocks sending, an EMAIL provider key is
 *    refused before it is probed or stored. The relay's pause would mean
 *    nothing if the tenant it stops could add their own Resend or Postmark
 *    key and keep sending; non-email providers pass untouched.
 *  - **A from-address must be one the provider will actually send from.** When
 *    the probe returns the provider's verified domains, the address's domain
 *    must be among them. The failure this prevents is a tenant sending through
 *    their own Resend account from the engine's default `noreply@hogsend.com`.
 *  - **Only a RUNNING stack is touched.** Anything earlier is the provisioning
 *    pipeline's job — its `set-env` step reads the same store through the same
 *    `buildProviderEnv`, so a key saved during onboarding lands on first boot
 *    without this module racing a half-built stack.
 *  - **A sync is a full re-assertion, with nulls for what is gone.** The desired
 *    env is recomputed from ALL stored credentials, and every env name this
 *    layer owns that the new set does NOT produce is sent as `null`. That is
 *    what makes removal real rather than cosmetic.
 *  - **`HOGSEND_TEST_MODE` survives every write.** A non-production environment
 *    re-asserts it on each sync, so no key change can ever quietly arm a staging
 *    or test stack to send for real.
 *  - **Nothing here logs a secret.** The audit detail carries env var NAMES.
 */

/** The actor recorded when a caller does not name one. */
const DEFAULT_ACTOR = "system";

/** The audit action a successful env sync writes. */
export const KEY_SYNC_AUDIT_ACTION = "provider_key.synced";

/**
 * What stops working when a credential is removed, in tenant words. The UI
 * (task 2) shows these before it asks for confirmation; they live here because
 * the consequence is a property of the provider, not of a screen.
 */
export const INERT_ON_REMOVAL: Record<string, readonly string[]> = {
  resend: [
    "email sending (journeys, broadcasts, transactional)",
    "delivery and bounce webhooks",
  ],
  postmark: [
    "email sending (journeys, broadcasts, transactional)",
    "delivery and bounce webhooks",
  ],
  posthog: [
    "person-property reads used by journey conditions",
    "event mirroring to PostHog",
  ],
  twilio: ["SMS sending", "inbound STOP/START handling"],
  [SENDER_IDENTITY_PROVIDER]: [
    "sending from your own domain (the engine falls back to its default from-address)",
  ],
};

/** The features that go inert without `provider`. Empty when we know of none. */
export function inertFeatures(provider: string): readonly string[] {
  return INERT_ON_REMOVAL[provider] ?? [];
}

export interface KeySyncDeps {
  db: CloudDb;
  substrate: SubstrateProvider;
  providerKeys: ProviderKeyService;
  stackService: StackService;
  /** Injected so tests never reach a vendor. */
  fetchImpl: FetchImpl;
}

type ResolvedDeps = Omit<KeySyncDeps, "substrate"> & {
  substrate: SubstrateProvider | undefined;
};

const providerSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "Provider must be a lowercase plugin id");

const actorSchema = z.string().min(1).max(200).optional();

const storeInputSchema = z.object({
  organizationId: z.string().min(1),
  environmentId: z.uuid(),
  provider: providerSchema,
  payload: providerKeyPayloadSchema,
  fromAddress: z.string().min(3).max(320).optional(),
  actor: actorSchema,
});

const removeInputSchema = z.object({
  organizationId: z.string().min(1),
  environmentId: z.uuid(),
  provider: providerSchema,
  actor: actorSchema,
});

export type StoreAndSyncInput = z.input<typeof storeInputSchema>;
export type RemoveAndSyncInput = z.input<typeof removeInputSchema>;

/** Why a submission was refused. Each maps to a message the UI already knows. */
export type StoreRejectionReason =
  | "invalid_key"
  | "from_address_malformed"
  | "from_domain_unverified"
  | "sending_paused";

export interface SyncOutcome {
  /** True when the substrate was actually written to (a `running` stack). */
  synced: boolean;
  /** The env names asserted on the stack, sorted. Empty when not synced. */
  envKeys: string[];
}

export type StoreAndSyncResult =
  | { stored: false; reason: StoreRejectionReason; detail: string }
  | ({
      stored: true;
      detail: string;
      key: ProviderKeySummary;
      verifiedDomains?: string[];
    } & SyncOutcome);

export type RemoveAndSyncResult = {
  removed: boolean;
  inert: readonly string[];
} & SyncOutcome;

/**
 * Read the seam fields out of the stored jsonb, which also carries the
 * pipeline's own bookkeeping keys. Null for a stack that never reached a
 * substrate — which is why every substrate call below is conditional.
 */
function readRefs(stack: StackRow): StackRefs | null {
  const raw = stack.substrateRefs as Record<string, unknown>;
  if (!raw || typeof raw.substrate !== "string") return null;
  if (typeof raw.apiPublicUrl !== "string") return null;
  return {
    substrate: raw.substrate,
    apiPublicUrl: raw.apiPublicUrl,
    data: (raw.data as Record<string, unknown>) ?? {},
  };
}

export class KeySyncService {
  private readonly deps: ResolvedDeps;

  constructor(deps: Partial<KeySyncDeps> = {}) {
    this.deps = {
      db: deps.db ?? defaultDb,
      substrate: deps.substrate,
      providerKeys: deps.providerKeys ?? new ProviderKeyService(deps.db),
      stackService: deps.stackService ?? new StackService(deps.db),
      fetchImpl: deps.fetchImpl ?? fetch,
    };
  }

  /**
   * Resolved on USE, not on construction: `getSubstrate()` throws under a
   * misconfigured railway substrate, and that must fail a sync rather than the
   * import of any module that mentions this service.
   */
  private substrate(): SubstrateProvider {
    return this.deps.substrate ?? getSubstrate();
  }

  /**
   * Validate, store, verify, and push to the stack.
   *
   * Returns a refusal rather than throwing: "your key is wrong" is an ordinary
   * answer a form must render, not an exception.
   */
  async storeAndSync(input: StoreAndSyncInput): Promise<StoreAndSyncResult> {
    const {
      organizationId,
      environmentId,
      provider,
      payload,
      fromAddress,
      actor,
    } = storeInputSchema.parse(input);

    // DECISIONS §6: a tenant whose sending is paused gets no escape hatch
    // through their own email provider. Answered BEFORE the vendor probe (the
    // key never leaves the control plane) and BEFORE the store (nothing is
    // staged for a later provisioning `set-env` to sync). Only the EMAIL
    // providers are a reroute — a PostHog or Twilio key passes untouched —
    // and the status is read live on every save, so a reinstatement restores
    // this path with no further write. `saveSenderIdentity` replays the
    // stored email key through here, so it is gated by the same read.
    if (EMAIL_PROVIDER_IDS.includes(provider)) {
      const sending = await readEmailSendingStatus({
        environmentId,
        db: this.deps.db,
      });
      if (blocksSending(sending.status)) {
        return {
          stored: false,
          reason: "sending_paused",
          detail: sending.status,
        };
      }
    }

    const validation = await validateProviderKey({
      provider,
      payload,
      fetchImpl: this.deps.fetchImpl,
    });
    if (!validation.valid) {
      return {
        stored: false,
        reason: "invalid_key",
        detail: validation.detail,
      };
    }

    const gate = checkSenderIdentity(fromAddress, validation);
    if (gate.rejected) {
      return { stored: false, reason: gate.reason, detail: gate.detail };
    }

    const stored = await this.deps.providerKeys.store({
      organizationId,
      environmentId,
      provider,
      payload,
      actor,
    });
    // The probe just succeeded, so the stamp is a fact rather than a promise.
    const verified = await this.deps.providerKeys.markVerified({
      environmentId,
      provider,
      actor,
    });

    if (fromAddress) {
      await this.deps.providerKeys.store({
        organizationId,
        environmentId,
        provider: SENDER_IDENTITY_PROVIDER,
        payload: { from: fromAddress },
        actor,
      });
      // Marked verified ONLY when the domain was actually checked against a
      // list. A provider that exposes no domains leaves this honestly unproven.
      if (gate.domainVerified) {
        await this.deps.providerKeys.markVerified({
          environmentId,
          provider: SENDER_IDENTITY_PROVIDER,
          actor,
        });
      }
    }

    const sync = await this.syncEnvironment({
      organizationId,
      environmentId,
      provider,
      actor,
    });

    return {
      stored: true,
      detail: validation.detail,
      key: verified.found ? verified.key : stored.key,
      ...(validation.verifiedDomains
        ? { verifiedDomains: validation.verifiedDomains }
        : {}),
      ...sync,
    };
  }

  /**
   * Delete a credential and unset its env vars on the stack. Removing a key
   * that is not there is not an error — the end state the caller wanted holds.
   */
  async removeAndSync(input: RemoveAndSyncInput): Promise<RemoveAndSyncResult> {
    const { organizationId, environmentId, provider, actor } =
      removeInputSchema.parse(input);
    const inert = inertFeatures(provider);

    const removed = await this.deps.providerKeys.remove({
      environmentId,
      provider,
      actor,
    });
    if (!removed.removed) {
      return { removed: false, inert, synced: false, envKeys: [] };
    }

    const sync = await this.syncEnvironment({
      organizationId,
      environmentId,
      provider,
      actor,
      removed: true,
    });
    return { removed: true, inert, ...sync };
  }

  /**
   * Re-assert the whole provider env on a RUNNING stack, then restart it so the
   * new values are read. A stack in any other status is left alone: the
   * provisioning pipeline sets env from the same store on its way up.
   */
  private async syncEnvironment(args: {
    organizationId: string;
    environmentId: string;
    provider: string;
    actor: string | undefined;
    removed?: boolean;
  }): Promise<SyncOutcome> {
    const stack = await this.deps.stackService.getByEnvironment({
      environmentId: args.environmentId,
    });
    if (!stack || stack.status !== "running") return notSynced();

    const refs = readRefs(stack);
    if (!refs) return notSynced();

    const desired = await this.desiredEnv(args.environmentId);

    // The unset half of the diff: everything this layer OWNS that the current
    // credentials no longer produce. Without it a removed key would linger in
    // the stack's environment and keep working.
    const vars: SubstrateEnvVars = {};
    for (const name of PROVIDER_ENV_OWNED_NAMES) {
      if (!(name in desired)) vars[name] = null;
    }
    Object.assign(vars, desired);

    await this.substrate().setEnv(refs, vars);
    // Env changes are read at boot; without a restart the instance keeps
    // running on the credentials it started with.
    await this.substrate().redeploy(refs);

    const envKeys = Object.keys(desired).sort();
    await writeAudit(this.deps.db, {
      actor: args.actor ?? DEFAULT_ACTOR,
      organizationId: args.organizationId,
      action: KEY_SYNC_AUDIT_ACTION,
      subject: args.environmentId,
      // NAMES only — the values are exactly what must never reach a log.
      detail: {
        provider: args.provider,
        removed: args.removed === true,
        stackId: stack.id,
        set: envKeys,
        unset: Object.entries(vars)
          .filter(([, value]) => value === null)
          .map(([name]) => name)
          .sort(),
      },
    });

    return { synced: true, envKeys };
  }

  /** Every stored credential for the environment, mapped to engine env vars. */
  private async desiredEnv(
    environmentId: string,
  ): Promise<Record<string, string>> {
    const { keys } = await this.deps.providerKeys.list({ environmentId });
    const stored: StoredProviderKey[] = [];
    for (const key of keys) {
      const decrypted = await this.deps.providerKeys.getDecrypted({
        environmentId,
        provider: key.provider,
      });
      if (decrypted.found) {
        stored.push({ provider: key.provider, payload: decrypted.payload });
      }
    }

    const vars = buildProviderEnv({ keys: stored });

    // Re-asserted on EVERY write, never merely inherited: a non-production
    // stack must not be one env patch away from sending for real.
    const [environment] = await this.deps.db
      .select({ kind: environments.kind })
      .from(environments)
      .where(eq(environments.id, environmentId))
      .limit(1);
    if (!environment) throw new NotFoundError("Environment", environmentId);
    if (environment.kind !== "production") vars.HOGSEND_TEST_MODE = "true";

    return vars;
  }
}

function notSynced(): SyncOutcome {
  return { synced: false, envKeys: [] };
}

type SenderIdentityGate =
  | { rejected: true; reason: StoreRejectionReason; detail: string }
  | { rejected: false; domainVerified: boolean };

/**
 * The from-address gate.
 *
 * When the provider told us which domains are verified, membership is REQUIRED.
 * When it exposes no such list (Postmark and friends), the address is accepted
 * and recorded as unproven rather than blocked — refusing every non-Resend
 * tenant would be a fail-closed with no security value, since the provider
 * itself rejects an unowned sender at send time.
 */
function checkSenderIdentity(
  fromAddress: string | undefined,
  validation: ProviderKeyValidation,
): SenderIdentityGate {
  if (!fromAddress) return { rejected: false, domainVerified: false };

  const domain = emailDomainOf(fromAddress);
  if (!domain) {
    return {
      rejected: true,
      reason: "from_address_malformed",
      detail: "malformed_address",
    };
  }
  if (!validation.verifiedDomains) {
    return { rejected: false, domainVerified: false };
  }
  if (!validation.verifiedDomains.includes(domain)) {
    return { rejected: true, reason: "from_domain_unverified", detail: domain };
  }
  return { rejected: false, domainVerified: true };
}

/** Default instance bound to the app pool — the usual import for callers. */
export const keySyncService = new KeySyncService();
