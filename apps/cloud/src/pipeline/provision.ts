import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { CloudDb } from "../db";
import { db as defaultDb } from "../db";
import { cells, environments, organizations, stacks } from "../db/schema";
import { env } from "../env";
import { defaultImageTag, qualifyImage } from "../images/index";
import { decryptSecretPayload, encryptSecretPayload } from "../lib/crypto";
import { readStackRefs } from "../lib/stack-refs";
import { writeAudit } from "../services/audit";
import { NotFoundError } from "../services/errors";
import { HatchetTenantService } from "../services/hatchet-tenant";
import type { StackRow } from "../services/orgs";
import {
  buildProviderEnv,
  type StoredProviderKey,
} from "../services/provider-env";
import { ProviderKeyService } from "../services/provider-keys";
import { StackService } from "../services/stacks";
import { TenantDbService } from "../services/tenant-db";
import {
  getSubstrate,
  type StackRefs,
  type SubstrateProvider,
} from "../substrate";
import { MIGRATE_PRE_DEPLOY_COMMAND, WORKER_START_COMMAND } from "./build";

/**
 * The provisioning pipeline: `requested` → `running`, one named step at a time.
 *
 * The laws this module exists to hold (PRD 04):
 *
 *  - **Every step is idempotent, and proves it from PERSISTED state.** A step
 *    that already ran leaves an artifact on the stack row (an encrypted DSN, an
 *    encrypted Hatchet token, `substrate_refs`), and re-running the pipeline
 *    SKIPS it by finding that artifact. This is what makes a dashboard retry
 *    "resume from the failed step" rather than "start again": the pipeline has
 *    no memory of its own, only the row's.
 *  - **Status is never written here.** Every transition goes through
 *    `StackService` (the sole legal writer, PRD 02) so the legal-edge table and
 *    the audit row cannot come apart.
 *  - **A failure parks the stack.** Any step that throws is recorded via
 *    `StackService.recordError` — status `error`, `last_error` naming the STEP,
 *    `retry_count` incremented — and the pipeline returns rather than throwing,
 *    because its callers are a durable task and a fire-and-forget queue, and
 *    neither has anywhere useful to put an exception.
 *  - **Nothing here logs a secret.** DSNs, Hatchet tokens, auth secrets and
 *    provider keys travel from their store to `substrate.setEnv` and are never
 *    stringified into a log line, an audit detail, or an error message.
 */

/** The pipeline, in order. Exported so tests + the dashboard can name a step. */
export const PROVISION_STEPS = [
  "start",
  "ensure-tenant-db",
  "mint-hatchet",
  "substrate-provision",
  "set-env",
  "health-wait",
  "mint-credentials",
  "finish",
] as const;

export type ProvisionStep = (typeof PROVISION_STEPS)[number];

/** The audit `action` a step writes. `stack.provision.set-env`, … */
export function provisionAuditAction(step: ProvisionStep): string {
  return `stack.provision.${step}`;
}

/** The actor recorded on every row this pipeline writes. */
export const PROVISIONER_ACTOR = "provisioner";

/** Health poll: first wait, then doubling, capped — a stack takes minutes. */
const HEALTH_POLL_BASE_MS = 500;
const HEALTH_POLL_MAX_MS = 15_000;
/** PRD 04: the whole health wait gives up after ten minutes. */
const HEALTH_DEADLINE_MS = 600_000;

export interface ProvisionDeps {
  db: CloudDb;
  substrate: SubstrateProvider;
  tenantDb: TenantDbService;
  hatchetTenant: HatchetTenantService;
  providerKeys: ProviderKeyService;
  stackService: StackService;
  /** Injected so a test can drive the health wait without real time. */
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  healthDeadlineMs: number;
  healthPollBaseMs: number;
  /** Tag suffix for the stock scaffold image. */
  defaultEngineVersion: string;
  /** Fresh `BETTER_AUTH_SECRET` material. Injected only for determinism tests. */
  generateSecret: () => string;
}

export interface ProvisionStepReport {
  step: ProvisionStep;
  /** True when a persisted artifact made the work unnecessary. */
  skipped: boolean;
}

export type ProvisionResult =
  | { stackId: string; status: "running"; steps: ProvisionStepReport[] }
  | {
      stackId: string;
      status: "error";
      steps: ProvisionStepReport[];
      failedStep: ProvisionStep;
      error: string;
    };

function defaultDeps(): ProvisionDeps {
  return {
    db: defaultDb,
    // Resolved lazily per run: `getSubstrate()` throws under a misconfigured
    // railway substrate, and that must fail a PROVISION, not module import.
    substrate: getSubstrate(),
    tenantDb: new TenantDbService(),
    hatchetTenant: new HatchetTenantService(),
    providerKeys: new ProviderKeyService(),
    stackService: new StackService(),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    healthDeadlineMs: HEALTH_DEADLINE_MS,
    healthPollBaseMs: HEALTH_POLL_BASE_MS,
    defaultEngineVersion: env.CLOUD_DEFAULT_ENGINE_VERSION,
    generateSecret: () => randomBytes(32).toString("base64url"),
  };
}

/** Secrets the CONTROL PLANE mints for a stack (`stack_secrets_encrypted`). */
interface StackSecrets {
  betterAuthSecret: string;
}

/** Everything one run reads once, up front. */
interface ProvisionContext {
  stack: StackRow;
  environmentName: string;
  environmentKind: "production" | "staging" | "test";
  organizationId: string;
  plan: "trial" | "self_serve" | "dedicated";
  /** Decrypted cell admin DSN. Null for a dedicated (cell-less) org. */
  cellDsn: string | null;
  /** The cell's Hatchet address, verbatim from the row. */
  cellHatchetUrl: string | null;
  /** The cell's explicit Hatchet HTTP API base, when its ports differ. */
  cellHatchetApiUrl: string | null;
}

async function loadContext(
  db: CloudDb,
  stackId: string,
): Promise<ProvisionContext> {
  const [row] = await db
    .select({
      stack: stacks,
      environmentName: environments.name,
      environmentKind: environments.kind,
      plan: organizations.plan,
      cellDsn: cells.sharedClusterDsn,
      cellHatchetUrl: cells.sharedHatchetUrl,
      cellHatchetApiUrl: cells.sharedHatchetApiUrl,
    })
    .from(stacks)
    .innerJoin(environments, eq(environments.id, stacks.environmentId))
    .innerJoin(organizations, eq(organizations.id, stacks.organizationId))
    .leftJoin(cells, eq(cells.id, organizations.cellId))
    .where(eq(stacks.id, stackId))
    .limit(1);

  if (!row) throw new NotFoundError("Stack", stackId);

  return {
    stack: row.stack,
    environmentName: row.environmentName,
    environmentKind: row.environmentKind,
    organizationId: row.stack.organizationId,
    plan: row.plan,
    // Cell DSNs live encrypted at rest; this is the only place they are opened.
    cellDsn: row.cellDsn ? decryptSecretPayload<string>(row.cellDsn) : null,
    cellHatchetUrl: row.cellHatchetUrl,
    cellHatchetApiUrl: row.cellHatchetApiUrl,
  };
}

/**
 * Hatchet's HTTP API (token minting) and its gRPC endpoint (the engine client)
 * are two addresses.
 *
 * When the cell carries `shared_hatchet_api_url` — the second column the PRD 04
 * notes predicted, and what a Railway cell actually needs, its API behind
 * `https://<svc>.up.railway.app` and its gRPC behind an unrelated
 * `<proxy>:<port>` — that value IS the HTTP base and `shared_hatchet_url` is
 * the gRPC `host:port` (any accidental scheme on it is stripped).
 *
 * With no override, the legacy single-address derivation applies unchanged: a
 * scheme-carrying value is the HTTP base and a bare `host:port` is the gRPC
 * address, each deriving the other by the obvious rule.
 */
function hatchetAddresses(
  url: string,
  apiUrl?: string | null,
): { httpBase: string; hostPort: string } {
  const trimmed = url.replace(/\/+$/, "");
  if (apiUrl) {
    const base = apiUrl.replace(/\/+$/, "");
    return {
      // A bare API host is assumed TLS: a split-port cell is a hosted one.
      httpBase: /^https?:\/\//.test(base) ? base : `https://${base}`,
      hostPort: trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ""),
    };
  }
  if (/^https?:\/\//.test(trimmed)) {
    return { httpBase: trimmed, hostPort: trimmed.replace(/^https?:\/\//, "") };
  }
  return { httpBase: `http://${trimmed}`, hostPort: trimmed };
}

/**
 * Run the pipeline for one stack. Safe to re-run at any point: completed steps
 * skip on their persisted artifacts.
 *
 * Returns rather than throws on a step failure — the stack is already parked in
 * `error` with the step name by then, and both callers (the Hatchet task and
 * the in-process queue) want a value, not an exception.
 */
export async function runProvisionPipeline(
  input: { stackId: string },
  overrides: Partial<ProvisionDeps> = {},
): Promise<ProvisionResult> {
  const deps: ProvisionDeps = { ...defaultDeps(), ...overrides };
  const { stackId } = input;
  const steps: ProvisionStepReport[] = [];
  let current: ProvisionStep = "start";

  const audit = async (
    step: ProvisionStep,
    organizationId: string,
    detail: Record<string, unknown>,
  ): Promise<void> => {
    await writeAudit(deps.db, {
      actor: PROVISIONER_ACTOR,
      organizationId,
      action: provisionAuditAction(step),
      subject: stackId,
      detail,
    });
  };

  const context = await loadContext(deps.db, stackId);
  const { organizationId } = context;

  try {
    // ---- start ------------------------------------------------------------
    // `provisioning` is legal from `requested` AND from `error` — the retry
    // edge — so one call covers a first run and a dashboard resume. A stack
    // ALREADY in `provisioning` is not an error either: that is what a replayed
    // durable task looks like.
    current = "start";
    let stack = context.stack;
    if (stack.status === "running") {
      // Nothing to do, and nothing to say: a second enqueue for a finished
      // stack must not walk it back through provisioning.
      return { stackId, status: "running", steps };
    }
    if (stack.status !== "provisioning") {
      stack = await deps.stackService.transition({
        stackId,
        to: "provisioning",
        actor: PROVISIONER_ACTOR,
        detail: { step: "start", from: stack.status },
      });
    }
    steps.push({ step: "start", skipped: stack.status === "provisioning" });
    await audit("start", organizationId, { from: context.stack.status });

    // ---- ensure-tenant-db -------------------------------------------------
    current = "ensure-tenant-db";
    const dbName = stack.dbName;
    if (!dbName) throw new Error(`Stack ${stackId} carries no db_name`);

    let tenantDsn: string;
    let poolMax = 3;
    if (stack.dbDsnEncrypted) {
      // The artifact of a previous run: reuse it verbatim. Re-creating would
      // report `alreadyExists` with no DSN, and rotating would break a stack
      // that is already running on this credential.
      tenantDsn = decryptSecretPayload<string>(stack.dbDsnEncrypted);
      steps.push({ step: "ensure-tenant-db", skipped: true });
      await audit("ensure-tenant-db", organizationId, {
        dbName,
        reused: true,
      });
    } else {
      if (!context.cellDsn) {
        throw new Error(
          `Organization ${organizationId} has no cell; dedicated-topology provisioning is not implemented (PRD 04 task 5)`,
        );
      }
      const created = await deps.tenantDb.create({
        cellDsn: context.cellDsn,
        dbName,
      });
      if (created.alreadyExists) {
        // The database is there but its password is unknowable — a run that
        // died between CREATE and persist. Rotating is the ONLY way back, and
        // is safe precisely because `set-env` re-pushes the DSN below.
        const reset = await deps.tenantDb.resetCredentials({
          cellDsn: context.cellDsn,
          dbName,
        });
        tenantDsn = reset.dsn;
        poolMax = reset.poolMax;
      } else {
        tenantDsn = created.dsn;
        poolMax = created.poolMax;
      }
      stack = await patchStack(deps.db, stackId, {
        dbDsnEncrypted: encryptSecretPayload(tenantDsn),
      });
      steps.push({ step: "ensure-tenant-db", skipped: false });
      await audit("ensure-tenant-db", organizationId, {
        dbName,
        rotated: created.alreadyExists,
        poolMax,
      });
    }

    // ---- mint-hatchet -----------------------------------------------------
    current = "mint-hatchet";
    const namespace = stack.hatchetNamespace ?? stackId;
    let hatchetToken: string;
    if (!context.cellHatchetUrl) {
      throw new Error(
        `Organization ${organizationId} has no cell Hatchet url; cannot mint a tenant token`,
      );
    }
    const addresses = hatchetAddresses(
      context.cellHatchetUrl,
      context.cellHatchetApiUrl,
    );
    const hatchetHostPort = addresses.hostPort;
    if (stack.hatchetTokenEncrypted) {
      hatchetToken = decryptSecretPayload<string>(stack.hatchetTokenEncrypted);
      steps.push({ step: "mint-hatchet", skipped: true });
      await audit("mint-hatchet", organizationId, { namespace, reused: true });
    } else {
      const minted = await deps.hatchetTenant.mintToken({
        hatchetUrl: addresses.httpBase,
        tenantSlug: namespace,
      });
      hatchetToken = minted.token;
      stack = await patchStack(deps.db, stackId, {
        hatchetTokenEncrypted: encryptSecretPayload(minted.token),
        hatchetNamespace: namespace,
      });
      steps.push({ step: "mint-hatchet", skipped: false });
      await audit("mint-hatchet", organizationId, {
        namespace,
        createdTenant: minted.createdTenant,
      });
    }

    // ---- substrate-provision ----------------------------------------------
    current = "substrate-provision";
    const engineVersion = stack.engineVersion ?? deps.defaultEngineVersion;
    let refs = readStackRefs(stack);
    if (refs) {
      steps.push({ step: "substrate-provision", skipped: true });
      await audit("substrate-provision", organizationId, {
        substrate: refs.substrate,
        reused: true,
      });
    } else {
      refs = await deps.substrate.provisionStack({
        stackId,
        organizationId,
        environmentName: context.environmentName,
        region: stack.region,
        topology: context.plan === "dedicated" ? "dedicated" : "shared",
        // Registry-qualified when one is configured: the substrate has to be
        // able to PULL this, and a bare tag is only resolvable on a host that
        // already built it (dev, with the fake substrate).
        initialImage: qualifyImage(defaultImageTag(engineVersion)),
        // The scaffold image's migrations gate (template Dockerfile law: tsx,
        // never pnpm, at runtime). Without it the first boot meets an empty
        // tenant database and the engine's schema guard crash-loops.
        preDeployCommand: MIGRATE_PRE_DEPLOY_COMMAND,
        // One image, three run modes: the worker must be told which it is,
        // or it boots the image's default CMD — a second api.
        workerStartCommand: WORKER_START_COMMAND,
        // Env is set as its own step: the values below are assembled from four
        // stores and a half-configured stack is easier to reason about than a
        // provision call that half-failed.
        env: {},
      });
      stack = await patchStack(deps.db, stackId, {
        substrateRefs: { ...refs },
        engineVersion,
      });
      steps.push({ step: "substrate-provision", skipped: false });
      await audit("substrate-provision", organizationId, {
        substrate: refs.substrate,
        engineVersion,
        apiPublicUrl: refs.apiPublicUrl,
      });
    }

    // ---- set-env ----------------------------------------------------------
    current = "set-env";
    const secrets = await ensureStackSecrets(deps, stackId, stack);
    stack = secrets.stack;

    const vars = await assembleStackEnv({
      deps,
      context,
      refs,
      tenantDsn,
      poolMax,
      hatchetToken,
      hatchetHostPort,
      namespace,
      betterAuthSecret: secrets.secrets.betterAuthSecret,
    });
    await deps.substrate.setEnv(refs, vars);
    steps.push({ step: "set-env", skipped: false });
    // Audit the KEYS only. The names prove the env was assembled; the values
    // are exactly what must never reach a log.
    await audit("set-env", organizationId, { keys: Object.keys(vars).sort() });

    // ---- health-wait ------------------------------------------------------
    current = "health-wait";
    const waited = await waitForHealth(deps, refs);
    steps.push({ step: "health-wait", skipped: false });
    await audit("health-wait", organizationId, {
      attempts: waited.attempts,
      waitedMs: waited.waitedMs,
    });

    // ---- mint-credentials -------------------------------------------------
    // STUB (PRD 04 task 6 territory). The real step mints the tenant's first
    // Studio admin + an ingest-scoped API key against the RUNNING instance, and
    // FakeSubstrate hosts no engine to mint against. The step keeps its name
    // and its audit row so the gap is visible in the trail rather than implied
    // by an absence, and records `credentialsMinted: false` on the stack so the
    // dashboard can say "no keys yet" instead of guessing.
    current = "mint-credentials";
    stack = await patchStack(deps.db, stackId, {
      substrateRefs: {
        ...(stack.substrateRefs ?? {}),
        credentialsMinted: false,
      },
    });
    steps.push({ step: "mint-credentials", skipped: false });
    await audit("mint-credentials", organizationId, {
      credentialsMinted: false,
      reason:
        "tenant credential minting lands with the dashboard (PRD 04 task 6)",
    });

    // ---- finish -----------------------------------------------------------
    current = "finish";
    await deps.stackService.transition({
      stackId,
      to: "running",
      expectedFrom: "provisioning",
      actor: PROVISIONER_ACTOR,
      detail: { step: "finish" },
    });
    steps.push({ step: "finish", skipped: false });
    await audit("finish", organizationId, { status: "running" });

    return { stackId, status: "running", steps };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // `recordError` owns the status, the message and the retry counter in one
    // statement; the step name rides in `last_error` so a dashboard retry (and
    // a human) can see WHERE it stopped.
    await deps.stackService.recordError({
      stackId,
      error: `[${current}] ${message}`,
      step: current,
      actor: PROVISIONER_ACTOR,
    });
    return {
      stackId,
      status: "error",
      steps,
      failedStep: current,
      error: message,
    };
  }
}

/** Write step artifacts and return the fresh row. Never touches `status`. */
async function patchStack(
  db: CloudDb,
  stackId: string,
  patch: Partial<{
    dbDsnEncrypted: string;
    hatchetTokenEncrypted: string;
    hatchetNamespace: string;
    stackSecretsEncrypted: string;
    substrateRefs: Record<string, unknown>;
    engineVersion: string;
  }>,
): Promise<StackRow> {
  const [row] = await db
    .update(stacks)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(stacks.id, stackId))
    .returning();
  if (!row) throw new NotFoundError("Stack", stackId);
  return row;
}

/**
 * The control-plane-minted secrets, generated ONCE and replayed thereafter. A
 * regenerated `BETTER_AUTH_SECRET` would invalidate every session the tenant's
 * Studio had issued, so this is exactly as idempotent as the tenant DSN.
 */
async function ensureStackSecrets(
  deps: ProvisionDeps,
  stackId: string,
  stack: StackRow,
): Promise<{ stack: StackRow; secrets: StackSecrets }> {
  if (stack.stackSecretsEncrypted) {
    const stored = decryptSecretPayload<Partial<StackSecrets>>(
      stack.stackSecretsEncrypted,
    );
    if (typeof stored?.betterAuthSecret === "string") {
      return { stack, secrets: { betterAuthSecret: stored.betterAuthSecret } };
    }
  }
  const secrets: StackSecrets = { betterAuthSecret: deps.generateSecret() };
  const updated = await patchStack(deps.db, stackId, {
    stackSecretsEncrypted: encryptSecretPayload(secrets),
  });
  return { stack: updated, secrets };
}

/**
 * The full engine env for one stack (`packages/engine/src/env.ts` is the
 * contract). Assembled in one place so "what does a Hogsend instance need to
 * boot" has a single, readable answer.
 */
async function assembleStackEnv(args: {
  deps: ProvisionDeps;
  context: ProvisionContext;
  refs: StackRefs;
  tenantDsn: string;
  poolMax: number;
  hatchetToken: string;
  hatchetHostPort: string;
  namespace: string;
  betterAuthSecret: string;
}): Promise<Record<string, string>> {
  const { deps, context, refs } = args;

  const vars: Record<string, string> = {
    DATABASE_URL: args.tenantDsn,
    // Not an engine var TODAY (see `services/tenant-db.ts`): the ceiling is
    // carried beside the DSN so the day the engine reads it, no re-provision is
    // needed. Harmless meanwhile — the engine ignores unknown vars.
    DATABASE_POOL_MAX: String(args.poolMax),
    BETTER_AUTH_SECRET: args.betterAuthSecret,
    // Both derive from the substrate-issued origin: the instance must sign
    // cookies for the URL it is actually reachable at.
    BETTER_AUTH_URL: refs.apiPublicUrl,
    API_PUBLIC_URL: refs.apiPublicUrl,
    HATCHET_CLIENT_TOKEN: args.hatchetToken,
    HATCHET_CLIENT_HOST_PORT: args.hatchetHostPort,
    HATCHET_CLIENT_TLS_STRATEGY: "none",
    HATCHET_CLIENT_NAMESPACE: args.namespace,
    // The tenant's first admin is minted by the control plane (the
    // `mint-credentials` step), never by the instance bootstrapping one for
    // itself — an instance that self-issued an API key would hand anyone who
    // reached it a working credential.
    HOGSEND_BOOTSTRAP_API_KEY: "false",
  };

  // A Redis the substrate provisioned alongside the services. Optional: a
  // substrate that provides none leaves the engine on its own default rather
  // than pointing the stack at an address that does not answer.
  const redisUrl = refs.data?.redisUrl;
  if (typeof redisUrl === "string" && redisUrl.length > 0) {
    vars.REDIS_URL = redisUrl;
  }

  // Non-production environments never send for real. `true` (not `auto`) is
  // deliberate: `auto` goes live the moment a verified domain appears, which is
  // precisely the accident a staging stack must not have.
  if (context.environmentKind !== "production") {
    vars.HOGSEND_TEST_MODE = "true";
  }

  // Tenant provider credentials, mapped onto the env names their engine plugins
  // read — through the SAME `buildProviderEnv` the key-sync service uses on a
  // running stack (PRD 05), so a key cannot work on first boot and silently do
  // nothing on a rotation. `list()` carries no ciphertext, so each one is
  // opened explicitly.
  const { keys } = await deps.providerKeys.list({
    environmentId: context.stack.environmentId,
  });
  const stored: StoredProviderKey[] = [];
  for (const key of keys) {
    const decrypted = await deps.providerKeys.getDecrypted({
      environmentId: context.stack.environmentId,
      provider: key.provider,
    });
    if (!decrypted.found) continue;
    stored.push({ provider: key.provider, payload: decrypted.payload });
  }
  Object.assign(vars, buildProviderEnv({ keys: stored }));

  return vars;
}

/**
 * Poll until the stack is healthy or the deadline passes. Backoff doubles from
 * `healthPollBaseMs` to a 15s ceiling: a stack takes minutes to boot, and a
 * tight loop would be a self-inflicted denial of service on the substrate's
 * API for no earlier answer.
 */
async function waitForHealth(
  deps: ProvisionDeps,
  refs: StackRefs,
): Promise<{ attempts: number; waitedMs: number }> {
  const startedAt = deps.now();
  let delay = deps.healthPollBaseMs;
  let attempts = 0;
  let lastDetail: string | undefined;

  for (;;) {
    attempts += 1;
    const health = await deps.substrate.getHealth(refs);
    if (health.healthy) {
      return { attempts, waitedMs: deps.now() - startedAt };
    }
    lastDetail = health.detail;

    const elapsed = deps.now() - startedAt;
    if (elapsed + delay > deps.healthDeadlineMs) {
      throw new Error(
        `Stack did not become healthy within ${Math.round(deps.healthDeadlineMs / 1000)}s after ${attempts} checks${lastDetail ? ` (${lastDetail})` : ""}`,
      );
    }
    await deps.sleep(delay);
    delay = Math.min(delay * 2, HEALTH_POLL_MAX_MS);
  }
}
