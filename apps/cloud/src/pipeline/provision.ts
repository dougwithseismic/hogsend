import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { CloudDb } from "../db";
import { db as defaultDb } from "../db";
import {
  cells,
  environments,
  hostnames,
  organizations,
  stacks,
} from "../db/schema";
import {
  organization as authOrganization,
  member,
  user,
} from "../db/schema/auth";
import { type DnsProvider, getDns } from "../dns";
import { env } from "../env";
import { defaultImageTag, qualifyImage } from "../images/index";
import { welcomeEmailBody, welcomeEmailSubject } from "../lib/cloud-onboarding";
import { decryptSecretPayload, encryptSecretPayload } from "../lib/crypto";
import { type EmailSender, resolveEmailSender } from "../lib/email-sender";
import {
  buildInstanceHostname,
  isUsableSlug,
  refuseTenantZone,
} from "../lib/hostnames";
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
import { provisionSesTenant } from "../services/ses-tenants";
import { StackService } from "../services/stacks";
import {
  resolveTenantCredentialClient,
  TENANT_INGEST_KEY_NAME,
  type TenantCredentialClient,
  TenantCredentialError,
  type TenantSession,
} from "../services/tenant-credentials";
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
  // Before `set-env`, and it has to be: `set-env` freezes `API_PUBLIC_URL` and
  // `BETTER_AUTH_URL`, which mint every tracked link and sign the Studio
  // cookie. An instance that learns its own name after that point would need a
  // migration to change it; one that learns it here never knew another.
  "ensure-hostname",
  // Before `set-env`, and it has to be: `set-env` is what hands the instance
  // its environment, and the relay token this step mints exists in plaintext
  // exactly once — here. An instance provisioned after it would hold no
  // credential for the send relay and would have no way to ask for one.
  "provision-ses",
  "set-env",
  // AFTER `set-env`, and it has to be: an app service is created idle and only
  // starts here, so that its first boot is its first SUCCESSFUL boot. Starting
  // it any earlier means starting it without `DATABASE_URL`.
  "start-services",
  "health-wait",
  "mint-credentials",
  "finish",
] as const;

export type ProvisionStep = (typeof PROVISION_STEPS)[number];

const PROVISION_STEP_NAMES = new Set<string>(PROVISION_STEPS);

/**
 * The provision step named by `last_error`'s `[step] …` prefix, or null when
 * the failure came from somewhere else.
 *
 * `last_error` is written by `StackService.recordError`, and this pipeline
 * prefixes it with the failed step (`[set-env] …`). Other writers park stacks
 * in `error` too — the build sweep's `[build …]` reap, most notably — and those
 * are not the provisioner's: a stack parked by a failed PUBLISH has an image
 * problem, and re-provisioning it would re-run substrate steps that all skip
 * and then declare it `running` on the old image, hiding the failure the
 * operator needs to see.
 *
 * Declared HERE, next to the steps it matches against, and shared by all three
 * readers — the provision sweep's re-drive filter, the alert sweep's
 * `provision_exhausted` condition, and the environment page's copy. Those three
 * must name exactly the same set of stacks, and three hand-kept copies of one
 * regex is how two of them quietly drift apart. Returning the NAME rather than
 * a boolean lets the page say which step stopped.
 */
export function failedProvisionStep(
  lastError: string | null,
): ProvisionStep | null {
  const name = /^\[([^\]]+)\]/.exec(lastError ?? "")?.[1] ?? "";
  return PROVISION_STEP_NAMES.has(name) ? (name as ProvisionStep) : null;
}

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

/**
 * How long to wait for a managed hostname's certificate.
 *
 * Five minutes because that is the shape of the thing being waited on: Railway
 * observes the CNAME within a minute or so, then Let's Encrypt issues, and the
 * whole dance took roughly that long on the first live provision. Exhausting
 * this is NOT fatal to the hostname — the step throws retryable and the sweep
 * re-drives, by which time the certificate is invariably issued.
 */
const DOMAIN_DEADLINE_MS = 300_000;
const DOMAIN_POLL_MAX_MS = 15_000;

export interface ProvisionDeps {
  db: CloudDb;
  substrate: SubstrateProvider;
  /** Writes the managed hostname's record. The fake keeps an in-memory zone. */
  dns: DnsProvider;
  /**
   * The zone managed hostnames are minted inside, e.g. `hogsend.com`. Null
   * turns `ensure-hostname` into a no-op and leaves the instance on the
   * substrate's own URL — the state every stack provisioned before this step
   * existed is already in.
   */
  hostnameZone: string | null;
  /**
   * The domain our shared SSO cookie is scoped to. Not used to SET anything —
   * it is the value `refuseTenantZone` checks the tenant zone against, so a
   * misconfiguration that would leak our session cookie into tenant code is
   * refused here rather than discovered in a request log.
   */
  ssoCookieDomain: string | null;
  tenantDb: TenantDbService;
  hatchetTenant: HatchetTenantService;
  providerKeys: ProviderKeyService;
  stackService: StackService;
  /** Injected so a test can drive the health wait without real time. */
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  healthDeadlineMs: number;
  healthPollBaseMs: number;
  /** How long `ensure-hostname` waits for the certificate. */
  domainDeadlineMs: number;
  /** Tag suffix for the stock scaffold image. */
  defaultEngineVersion: string;
  /** Fresh `BETTER_AUTH_SECRET` material. Injected only for determinism tests. */
  generateSecret: () => string;
  /**
   * The HTTP leg of `mint-credentials`, against the tenant's own admin API.
   * Injected because the fake substrate hosts no engine to mint against.
   */
  tenantCredentials: TenantCredentialClient;
  /**
   * How the "your instance is running" mail leaves the building. Same seam the
   * OTP uses, so a test gets a spy and a fresh clone gets the log transport.
   */
  emailSender: EmailSender;
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
    // Lazy for the same reason the substrate is: a misconfigured Cloudflare
    // provider must fail a PROVISION, not a module import.
    dns: getDns(),
    hostnameZone: env.CLOUD_TENANT_ZONE ?? null,
    ssoCookieDomain: env.CLOUD_SSO_COOKIE_DOMAIN ?? null,
    tenantDb: new TenantDbService(),
    hatchetTenant: new HatchetTenantService(),
    providerKeys: new ProviderKeyService(),
    stackService: new StackService(),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    healthDeadlineMs: HEALTH_DEADLINE_MS,
    healthPollBaseMs: HEALTH_POLL_BASE_MS,
    domainDeadlineMs: DOMAIN_DEADLINE_MS,
    defaultEngineVersion: env.CLOUD_DEFAULT_ENGINE_VERSION,
    generateSecret: () => randomBytes(32).toString("base64url"),
    // A fake substrate serves no engine on `apiPublicUrl`, so the real HTTP
    // client would only ever time out there. Same choice `getSubstrate()`
    // already makes, read from the same env var.
    tenantCredentials: resolveTenantCredentialClient(),
    emailSender: resolveEmailSender(),
  };
}

/**
 * The managed hostname for this stack, or null when there is not one to give.
 *
 * Null is an ordinary outcome, not a failure: a control plane with no zone
 * configured (every deploy today) and an organization whose slug is unusable
 * both land here, and both simply keep the substrate's own URL.
 */
function resolveManagedHostname(
  deps: ProvisionDeps,
  context: ProvisionContext,
): string | null {
  if (!deps.hostnameZone) return null;

  // Refuse BEFORE naming anything. A tenant zone inside the SSO cookie's domain
  // would hand our session cookie to code the customer controls, and the
  // symptom is invisible — everything works.
  const zoneRefusal = refuseTenantZone({
    zone: deps.hostnameZone,
    ssoCookieDomain: deps.ssoCookieDomain,
  });
  if (zoneRefusal) {
    console.error(
      `[cloud] refusing to mint a managed hostname: ${zoneRefusal}`,
    );
    return null;
  }

  const slug = context.organizationSlug;
  if (!slug || !isUsableSlug(slug)) return null;

  try {
    return buildInstanceHostname({
      slug,
      environmentName: context.environmentName,
      zone: deps.hostnameZone,
    });
  } catch {
    // A tenant-chosen environment name that is not a legal DNS label. Not
    // worth failing a provision over — the instance keeps the substrate URL.
    return null;
  }
}

/**
 * Point the hostname at the instance: ask the substrate to serve it, publish
 * every record it asks for, then remember what we published.
 *
 * Returns null when the hostname could not be attached, and does NOT throw:
 * see the step's comment — a signup must not fail over a DNS blip. `reused`
 * distinguishes a re-driven run from the one that did the work.
 *
 * ORDER: substrate FIRST, DNS second. The substrate is the only party that
 * knows which records its custom domain needs — a CNAME to route it and an
 * ownership TXT to prove it, and Railway 404s a domain whose TXT is missing
 * even after the CNAME resolves. Computing the CNAME ourselves and publishing
 * that alone produces a hostname that looks configured and never verifies, so
 * we publish what we are TOLD rather than what we can guess.
 */
async function attachManagedHostname(input: {
  deps: ProvisionDeps;
  organizationId: string;
  environmentId: string;
  hostname: string;
  refs: StackRefs;
}): Promise<{ reused: boolean } | null> {
  const { deps, hostname, refs } = input;

  const [existing] = await deps.db
    .select()
    .from(hostnames)
    .where(eq(hostnames.hostname, hostname))
    .limit(1);

  // Someone else's name. Never repointed — that record may be a live instance
  // whose tracked links and Studio cookie both resolve through it.
  if (existing && existing.environmentId !== input.environmentId) {
    console.error(
      `[cloud] hostname ${hostname} already belongs to environment ${existing.environmentId}; leaving this stack on the substrate URL`,
    );
    return null;
  }

  try {
    const attachment = await deps.substrate.attachDomain(refs, hostname);
    if (attachment.records.length === 0) {
      // The substrate accepted the domain but has not said what it needs yet.
      // Publishing nothing and recording success would strand the hostname
      // half-configured, so treat it as not-yet and let the sweep re-drive.
      throw new Error(
        `substrate returned no DNS records for ${hostname}; nothing to publish yet`,
      );
    }

    const published: string[] = [];
    for (const record of attachment.records) {
      const handle = await deps.dns.ensureRecord({
        type: record.type,
        hostname: record.name,
        value: record.value,
      });
      published.push(handle.id);
    }

    if (existing) {
      await deps.db
        .update(hostnames)
        .set({ dnsRecordIds: published, updatedAt: new Date() })
        .where(eq(hostnames.id, existing.id));
      return { reused: true };
    }

    await deps.db.insert(hostnames).values({
      organizationId: input.organizationId,
      environmentId: input.environmentId,
      hostname,
      kind: "managed",
      dnsRecordIds: published,
    });
    return { reused: false };
  } catch (error) {
    console.error(`[cloud] could not attach hostname ${hostname}:`, error);
    return null;
  }
}

/**
 * Secrets the CONTROL PLANE mints for a stack (`stack_secrets_encrypted`).
 *
 * Exported because the dashboard reads the same blob back to show the customer
 * their Studio password and their ingest key. One declaration, so a field added
 * here cannot be silently missed by the reader.
 */
export interface StackSecrets {
  betterAuthSecret: string;
  /**
   * The tenant's first Studio admin password, generated HERE rather than by the
   * engine. When `STUDIO_ADMIN_PASSWORD` is set the engine uses it verbatim and
   * never logs it; left unset, the engine would generate one and print it to
   * the instance's log, where the control plane cannot read it and anyone with
   * log access can.
   */
  studioAdminPassword: string;
  /** The ingest key minted by `mint-credentials`. Absent until it lands. */
  ingestApiKey?: string;
  /** The instance-side id of that key, so a retry can recognise its own. */
  ingestApiKeyId?: string;
}

/** Everything one run reads once, up front. */
interface ProvisionContext {
  stack: StackRow;
  environmentName: string;
  environmentKind: "production" | "staging" | "test";
  organizationId: string;
  organizationName: string;
  /** Better Auth's org slug — the hostname's first label. Null when there is
   * no Better Auth row, which only a seed or a test can produce. */
  organizationSlug: string | null;
  plan: "trial" | "self_serve" | "dedicated";
  /** Decrypted cell admin DSN. Null for a dedicated (cell-less) org. */
  cellDsn: string | null;
  /** The cell's Hatchet address, verbatim from the row. */
  cellHatchetUrl: string | null;
  /** The cell's explicit Hatchet HTTP API base, when its ports differ. */
  cellHatchetApiUrl: string | null;
  /**
   * The organization owner's email — the tenant's Studio admin. Null only for a
   * control-plane org with no membership rows, which the real signup path
   * cannot produce.
   */
  ownerEmail: string | null;
}

/**
 * The owner's email, or the earliest member's when no row carries the `owner`
 * role. Roles are a comma-separated list ("owner,admin" is legal), so the match
 * is a substring test over the list rather than an equality check.
 */
export async function findOwnerEmail(
  db: CloudDb,
  organizationId: string,
): Promise<string | null> {
  const rows = await db
    .select({ email: user.email, role: member.role })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(eq(member.organizationId, organizationId))
    .orderBy(member.createdAt, member.id);

  const owner = rows.find((row) =>
    row.role
      .split(",")
      .map((value) => value.trim())
      .includes("owner"),
  );
  return owner?.email ?? rows[0]?.email ?? null;
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
      organizationName: organizations.name,
      // From Better Auth's own table, which is where the slug already lives.
      // Mirroring it onto `cloud.organizations` would be a second source of
      // truth for one identity, and the hostname is derived from it.
      organizationSlug: authOrganization.slug,
      cellDsn: cells.sharedClusterDsn,
      cellHatchetUrl: cells.sharedHatchetUrl,
      cellHatchetApiUrl: cells.sharedHatchetApiUrl,
    })
    .from(stacks)
    .innerJoin(environments, eq(environments.id, stacks.environmentId))
    .innerJoin(organizations, eq(organizations.id, stacks.organizationId))
    // LEFT, not INNER: the mirror is keyed by Better Auth's id, but a test or a
    // seed can create a control-plane org with no Better Auth row, and losing
    // the whole context row over a missing slug would break provisioning for a
    // hostname that is optional anyway.
    .leftJoin(authOrganization, eq(authOrganization.id, organizations.id))
    .leftJoin(cells, eq(cells.id, organizations.cellId))
    .where(eq(stacks.id, stackId))
    .limit(1);

  if (!row) throw new NotFoundError("Stack", stackId);

  return {
    stack: row.stack,
    environmentName: row.environmentName,
    environmentKind: row.environmentKind,
    organizationId: row.stack.organizationId,
    organizationName: row.organizationName,
    organizationSlug: row.organizationSlug,
    plan: row.plan,
    // Cell DSNs live encrypted at rest; this is the only place they are opened.
    cellDsn: row.cellDsn ? decryptSecretPayload<string>(row.cellDsn) : null,
    cellHatchetUrl: row.cellHatchetUrl,
    cellHatchetApiUrl: row.cellHatchetApiUrl,
    ownerEmail: await findOwnerEmail(db, row.stack.organizationId),
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

  /** Set only on the run that actually reaches `finish`. */
  let welcome: { stack: StackRow; context: ProvisionContext } | null = null;
  let result: ProvisionResult;

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
        // No image: the services are created idle and started by
        // `start-services`, once there is an env for them to boot against.
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

    // ---- ensure-hostname --------------------------------------------------
    // Give the instance its name on OUR zone before anything freezes a URL.
    //
    // The DNS write and the substrate attach are both idempotent, so a
    // re-driven run re-derives the same hostname and finds its own record
    // rather than failing on it. On any refusal the step is SKIPPED rather
    // than fatal: the instance stays on the substrate's own URL, which is
    // exactly where every stack provisioned before this step already lives.
    // A hostname is an improvement to provisioning, not a precondition for it,
    // and failing a signup over a DNS blip would be the wrong trade.
    current = "ensure-hostname";
    const hostname = resolveManagedHostname(deps, context);
    if (!hostname) {
      steps.push({ step: "ensure-hostname", skipped: true });
      await audit("ensure-hostname", organizationId, {
        skipped: true,
        reason: deps.hostnameZone
          ? "no usable slug, or the tenant zone was refused"
          : "no tenant zone configured",
      });
    } else {
      const attached = await attachManagedHostname({
        deps,
        organizationId,
        environmentId: stack.environmentId,
        hostname,
        refs,
      });
      let certified: { attempts: number; waitedMs: number } | null = null;
      if (attached) {
        // The domain exists; now wait for it to MEAN something. Deliberately
        // before the URL swap: adopting a hostname that cannot serve HTTPS is
        // how the first live provision died three steps later.
        certified = await waitForDomain(deps, refs, hostname);
        // Set on EVERY successful pass, not only the one that created the
        // record: a re-driven run finds its own row and must still point the
        // env at the hostname, or `set-env` would freeze the substrate URL for
        // an instance whose name already resolves.
        refs = { ...refs, apiPublicUrl: `https://${hostname}` };
        stack = await patchStack(deps.db, stackId, {
          substrateRefs: { ...refs },
        });
      }
      steps.push({
        step: "ensure-hostname",
        skipped: attached?.reused ?? true,
      });
      await audit("ensure-hostname", organizationId, {
        hostname,
        attached: attached !== null,
        reused: attached?.reused ?? false,
        certificateWaitMs: certified?.waitedMs ?? null,
      });
    }

    // ---- provision-ses ----------------------------------------------------
    // The environment's SES tenancy, and the two credentials the instance
    // needs to reach the send relay and to trust what the relay sends back.
    //
    // FATAL on failure, deliberately: the stack parks at `error` with this
    // step's name and the sweep re-drives it, which is the house pattern and
    // costs nothing here — no service has been started yet, so nothing is
    // orphaned. A control plane with NO AWS credentials never reaches that
    // branch: the factory yields the Fake, the converge succeeds, and the
    // tenancy is simply recorded unavailable.
    current = "provision-ses";
    const sesTenant = await provisionSesTenant(
      { environmentId: stack.environmentId, actor: PROVISIONER_ACTOR },
      { db: deps.db },
    );
    steps.push({ step: "provision-ses", skipped: false });
    // Names and regions. Never the relay token, never the webhook secret.
    await audit("provision-ses", organizationId, {
      tenantName: sesTenant.summary.tenantName,
      configurationSetName: sesTenant.summary.configurationSetName,
      awsRegion: sesTenant.summary.awsRegion,
      reputationPolicy: sesTenant.summary.reputationPolicy,
      available: sesTenant.summary.available,
      relayTokenRotated: sesTenant.relayTokenRotated,
    });

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
      studioAdminPassword: secrets.secrets.studioAdminPassword,
      relayToken: sesTenant.relayToken,
      emailWebhookSecret: sesTenant.webhookSecret,
      emailAvailable: sesTenant.summary.available,
    });
    await deps.substrate.setEnv(refs, vars);
    steps.push({ step: "set-env", skipped: false });
    // Audit the KEYS only. The names prove the env was assembled; the values
    // are exactly what must never reach a log.
    await audit("set-env", organizationId, { keys: Object.keys(vars).sort() });

    // ---- start-services ---------------------------------------------------
    // Worker first, then api. The worker registers its journey tasks with
    // Hatchet on boot; bringing the api up first would open the front door on a
    // stack that cannot yet execute anything it accepts.
    current = "start-services";
    const bootImage = qualifyImage(defaultImageTag(engineVersion));
    for (const service of ["worker", "api"] as const) {
      await deps.substrate.deployImage(refs, {
        imageUrl: bootImage,
        service,
        preDeployCommand: MIGRATE_PRE_DEPLOY_COMMAND,
      });
    }
    steps.push({ step: "start-services", skipped: false });
    await audit("start-services", organizationId, { image: bootImage });

    // ---- health-wait ------------------------------------------------------
    current = "health-wait";
    const waited = await waitForHealth(deps, refs);
    steps.push({ step: "health-wait", skipped: false });
    await audit("health-wait", organizationId, {
      attempts: waited.attempts,
      waitedMs: waited.waitedMs,
    });

    // ---- mint-credentials -------------------------------------------------
    // The instance answered `health-wait` a moment ago, so its boot-time
    // first-admin bootstrap has already run off the env `set-env` pushed. This
    // step signs in as that admin and takes an ingest key out of the instance's
    // own admin API — the only place the full key is ever readable.
    //
    // It runs BEFORE `finish`, and it THROWS on failure, which is the ordering
    // that matters: a stack only reaches `running` with `credentialsMinted:
    // true` already on the row. A failed mint parks the stack at `error` with
    // this step's name, which the provision sweep re-drives on its first
    // condition — recovery, not just detection. (The sweep's third condition
    // still covers a `running` stack whose refs lost the flag some other way,
    // and T3 alerts on it.)
    current = "mint-credentials";
    if (!context.ownerEmail) {
      throw new Error(
        `Organization ${organizationId} has no member to make the tenant's Studio admin`,
      );
    }
    const minted = await mintTenantCredentials({
      deps,
      stackId,
      refs,
      email: context.ownerEmail,
      secrets: secrets.secrets,
    });
    stack = await patchStack(deps.db, stackId, {
      substrateRefs: {
        ...(stack.substrateRefs ?? {}),
        credentialsMinted: true,
      },
    });
    steps.push({ step: "mint-credentials", skipped: minted.reused });
    // The key's id and the count of orphans cleaned up. Never the key itself.
    await audit("mint-credentials", organizationId, {
      credentialsMinted: true,
      apiKeyId: minted.keyId,
      reused: minted.reused,
      revokedOrphans: minted.revokedOrphans,
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

    // Everything the welcome mail needs, handed to the SEND SITE BELOW — which
    // is outside this try on purpose (see there).
    welcome = { stack, context };
    result = { stackId, status: "running", steps };
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

  // OUTSIDE the try, and therefore outside the pipeline's failure contract.
  // This is the first instant the mail's own subject line is true: credentials
  // are minted and the stack is `running`. Sending any earlier — at signup, or
  // at `substrate-provision` — would promise a running instance that is still
  // provisioning.
  //
  // Placement is load-bearing, not stylistic. Inside the try, ANY throw from
  // here would land in the catch above and call `recordError` with
  // `current === "finish"` — and `running` is not a failable status, so that
  // call would itself throw `IllegalTransitionError` out of the whole
  // pipeline. A blipped row update would fail the provision task for a
  // customer whose instance is perfectly healthy.
  //
  // `sendWelcomeEmail` is additionally total (it catches its own errors), so
  // this is belt and braces on a path where the customer is already served.
  // A failed send is DROPPED, not retried: an already-`running` stack returns
  // at `start`, so nothing reaches this line twice. The environment page
  // carries every fact the mail does, so the cost is a missed nudge, not a
  // customer who cannot proceed.
  if (welcome) await sendWelcomeEmail(deps, welcome);

  return result;
}

/**
 * Tell the owner their instance is running, once.
 *
 * Once is enforced by a marker on `substrate_refs` rather than by the caller's
 * position in the pipeline: a stack that was parked and resumed can reach
 * `finish` more than once over its life, and a customer must not be welcomed
 * twice.
 *
 * TOTAL: it never throws, for any reason. It is called after the stack is
 * already `running`, and there is no failure in here worth walking that back
 * for — least of all the marker write, whose only job is to stop a second
 * copy of a mail the customer has already had.
 */
async function sendWelcomeEmail(
  deps: ProvisionDeps,
  input: { stack: StackRow; context: ProvisionContext },
): Promise<void> {
  const { stack, context } = input;
  const refs = stack.substrateRefs ?? {};
  if (refs.welcomeEmailSentAt) return;
  if (!context.ownerEmail) return;

  const facts = {
    organizationName: context.organizationName,
    environmentName: context.environmentName,
    environmentId: stack.environmentId,
  };

  // ONE try around the send AND the marker write. The marker is not more
  // important than the send it records: a row update that blips must not
  // become an exception the caller has to think about.
  try {
    await deps.emailSender.send({
      to: context.ownerEmail,
      subject: welcomeEmailSubject(facts),
      text: welcomeEmailBody(facts),
    });
    // Only after the transport returned, so a mail that never left is never
    // recorded as sent.
    await patchStack(deps.db, stack.id, {
      substrateRefs: {
        ...refs,
        welcomeEmailSentAt: new Date(deps.now()).toISOString(),
      },
    });
  } catch (error) {
    console.warn(
      `[cloud:provision] welcome email failed for stack ${stack.id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
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
  const stored = stack.stackSecretsEncrypted
    ? decryptSecretPayload<Partial<StackSecrets>>(stack.stackSecretsEncrypted)
    : undefined;

  const secrets: StackSecrets = {
    betterAuthSecret:
      typeof stored?.betterAuthSecret === "string"
        ? stored.betterAuthSecret
        : deps.generateSecret(),
    // Filled in per FIELD, not per object: a stack provisioned before the admin
    // password existed must gain one without losing its auth secret.
    studioAdminPassword:
      typeof stored?.studioAdminPassword === "string"
        ? stored.studioAdminPassword
        : deps.generateSecret(),
    ingestApiKey: stored?.ingestApiKey,
    ingestApiKeyId: stored?.ingestApiKeyId,
  };

  const unchanged =
    stored?.betterAuthSecret === secrets.betterAuthSecret &&
    stored?.studioAdminPassword === secrets.studioAdminPassword;
  if (unchanged) return { stack, secrets };

  const updated = await patchStack(deps.db, stackId, {
    stackSecretsEncrypted: encryptSecretPayload(secrets),
  });
  return { stack: updated, secrets };
}

/** Merge new material into `stack_secrets_encrypted` without dropping the rest. */
async function persistStackSecrets(
  deps: ProvisionDeps,
  stackId: string,
  secrets: StackSecrets,
): Promise<StackRow> {
  return patchStack(deps.db, stackId, {
    stackSecretsEncrypted: encryptSecretPayload(secrets),
  });
}

/**
 * Bring the stack to "exactly one live ingest key, and the control plane holds
 * it" from whatever state a previous attempt left behind.
 *
 * The recoverable states, and what each one does:
 *
 *  - **Nothing minted yet.** Mint, persist, done.
 *  - **Minted and persisted.** The stored id is still live on the instance ⇒
 *    reuse it. Nothing is rotated: the customer may already be sending with it.
 *  - **Minted but the persist failed.** A live key under our own name that the
 *    stored id does not match is an ORPHAN — valid forever, held by nobody.
 *    Revoke it and mint a replacement. This is why the name is a constant: it
 *    is the only handle a later run has on a key it never learned the id of.
 *  - **Persisted but the key was revoked from Studio.** Same path as an orphan:
 *    the stored key is dead, so a fresh one is minted.
 *
 * Order inside the mint: revoke orphans, mint, PERSIST, and only then does the
 * caller set `credentialsMinted`. A crash at any point leaves a state the list
 * above already covers.
 */
/**
 * Sign-in attempts before `mint-credentials` gives up and parks the stack.
 * Five, not eight: the tenant limits `/sign-in/email` to 10 per 60s, and a
 * burst that large is exactly what emptied the bucket for the CUSTOMER when
 * every caller shared one (observed live 2026-08-03).
 */
const SIGN_IN_ATTEMPTS = 5;
/** First backoff step; each retry doubles it, capped at 15s. */
const SIGN_IN_BACKOFF_BASE_MS = 1_000;
const SIGN_IN_BACKOFF_MAX_MS = 15_000;
/**
 * Backoff after a 429: the tenant's sign-in window is 60 seconds, so anything
 * shorter just re-burns the same bucket and turns the retry loop into the
 * attacker. Wait the whole window out (plus slack) before trying again.
 */
const SIGN_IN_RATE_LIMIT_BACKOFF_MS = 65_000;

/**
 * A sign-in failure that is the MOMENT's, not the credential's.
 *
 * `set-env` restarts the instance, so `mint-credentials` can arrive while the
 * substrate is still swapping containers and the new one is not yet routable.
 *
 * 401 and 403 are both EXCLUDED, and for the same reason: each is the
 * instance's own considered answer, not the moment's. 401 is a wrong password;
 * 403 is Better Auth's CSRF guard (`MISSING_OR_NULL_ORIGIN` — see the Origin
 * header in `createHttpTenantCredentialClient`). Re-driving either is futile,
 * and retrying 403 once cost eight attempts and a misdiagnosis before the
 * response BODY was read.
 *
 * 429 IS transient — the bucket refills — but it gets its own LONG backoff in
 * `signInWithRetry`: retrying inside the 60s window is what created the
 * lockout in the first place.
 */
function isTransientSignIn(error: unknown): boolean {
  if (!(error instanceof TenantCredentialError)) return false;
  // No status at all means the request never got an answer — a reach failure.
  if (error.status === undefined) return true;
  return error.status === 408 || error.status === 429 || error.status >= 500;
}

/** The tenant's rate limiter answered: the sign-in budget is spent. */
function isRateLimitedSignIn(error: unknown): boolean {
  return error instanceof TenantCredentialError && error.status === 429;
}

async function signInWithRetry(args: {
  deps: ProvisionDeps;
  baseUrl: string;
  email: string;
  password: string;
}): Promise<TenantSession> {
  const { deps } = args;
  let delay = SIGN_IN_BACKOFF_BASE_MS;
  let last: unknown;

  for (let attempt = 1; attempt <= SIGN_IN_ATTEMPTS; attempt += 1) {
    try {
      return await deps.tenantCredentials.signIn({
        baseUrl: args.baseUrl,
        email: args.email,
        password: args.password,
      });
    } catch (error) {
      last = error;
      if (!isTransientSignIn(error)) throw error;
      if (attempt === SIGN_IN_ATTEMPTS) break;
      if (isRateLimitedSignIn(error)) {
        // Sit out the whole rate-limit window; a short doubling retry would
        // spend the refilling budget and extend the lockout for everyone.
        await deps.sleep(SIGN_IN_RATE_LIMIT_BACKOFF_MS);
      } else {
        await deps.sleep(delay);
        delay = Math.min(delay * 2, SIGN_IN_BACKOFF_MAX_MS);
      }
    }
  }
  throw last;
}

async function mintTenantCredentials(args: {
  deps: ProvisionDeps;
  stackId: string;
  refs: StackRefs;
  email: string;
  secrets: StackSecrets;
}): Promise<{ keyId: string; reused: boolean; revokedOrphans: number }> {
  const { deps, refs, secrets } = args;
  const client = deps.tenantCredentials;
  const baseUrl = refs.apiPublicUrl;

  const session = await signInWithRetry({
    deps,
    baseUrl,
    email: args.email,
    password: secrets.studioAdminPassword,
  });

  const live = (await client.listKeys({ baseUrl, session })).filter(
    (key) => key.name === TENANT_INGEST_KEY_NAME && key.revokedAt === null,
  );

  const held =
    secrets.ingestApiKey && secrets.ingestApiKeyId
      ? live.find((key) => key.id === secrets.ingestApiKeyId)
      : undefined;

  // Every OTHER key under our name is an orphan whether or not one is held.
  const orphans = live.filter((key) => key.id !== held?.id);
  for (const orphan of orphans) {
    await client.revokeKey({ baseUrl, session, keyId: orphan.id });
  }

  if (held) {
    return { keyId: held.id, reused: true, revokedOrphans: orphans.length };
  }

  const created = await client.createKey({
    baseUrl,
    session,
    name: TENANT_INGEST_KEY_NAME,
  });
  await persistStackSecrets(deps, args.stackId, {
    ...secrets,
    ingestApiKey: created.key,
    ingestApiKeyId: created.id,
  });
  return { keyId: created.id, reused: false, revokedOrphans: orphans.length };
}

/**
 * The full engine env for one stack (`packages/engine/src/env.ts` is the
 * contract). Assembled in one place so "what does a Hogsend instance need to
 * boot" has a single, readable answer.
 */
/**
 * Whether a freshly provisioned instance SENDS through Hogsend Email.
 *
 * DECISIONS §6 says new provisions default to it. `available` is the whole
 * condition, and it is false exactly when the SES factory yielded the Fake.
 *
 * Activating over the Fake would be the worst available outcome: every send
 * would "succeed" against an in-memory client and no mail would ever leave.
 * Silent non-delivery beats a loud failure only in the sense that nobody
 * notices, which is precisely what makes it worse. So an environment
 * provisioned with no AWS credentials keeps whatever provider it already had,
 * and its three `HOGSEND_EMAIL_*` variables stay inert until a real tenancy
 * exists.
 *
 * Setting this at all is safe only because the engine preset now exists: it
 * registers the provider whenever `HOGSEND_EMAIL_TOKEN` is present, so the id
 * always resolves. Selecting one the engine cannot resolve throws at boot,
 * which is why this waited rather than shipping with the provisioning step.
 *
 * Its own function, and exported, because "did we activate a provider that
 * cannot actually deliver?" deserves a test that does not have to drive a
 * whole provision to ask.
 */
export function emailProviderVars(available: boolean): Record<string, string> {
  return available ? { EMAIL_PROVIDER: "hogsend" } : {};
}

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
  studioAdminPassword: string;
  /** Minted by `provision-ses`, one step earlier. Plaintext, exactly once. */
  relayToken: string;
  /** The secret the control plane signs this environment's webhooks with. */
  emailWebhookSecret: string;
  /**
   * Whether the SES tenancy is REAL (minted against AWS) rather than the Fake.
   * The only thing that may activate Hogsend Email as the sender.
   */
  emailAvailable: boolean;
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
    // Hogsend Email (PRD 06). The instance holds a relay token and nothing
    // else — the AWS credential never leaves the control plane, which is the
    // entire reason the relay exists rather than scoped IAM keys per stack.
    //
    // The ORIGIN, not a path: `plugin-hogsend` appends `/api/email/send` and
    // `/api/email/send-batch` itself.
    HOGSEND_EMAIL_RELAY_URL: env.CLOUD_PUBLIC_URL.replace(/\/+$/, ""),
    HOGSEND_EMAIL_TOKEN: args.relayToken,
    // What `plugin-hogsend.verifyWebhook` checks, so the instance can tell a
    // delivery from us apart from anything else that reaches its webhook.
    HOGSEND_EMAIL_WEBHOOK_SECRET: args.emailWebhookSecret,
    // ACTIVATION, and only when the tenancy is REAL. See `emailProviderVars`.
    ...emailProviderVars(args.emailAvailable),
  };

  // The engine's first-admin bootstrap: on boot, with the user table EMPTY, it
  // mints this admin and no other. Idempotent by construction, so a re-provision
  // never produces a second one. The password is generated and held by the
  // control plane so `mint-credentials` can sign in as this admin — that is the
  // whole reason a data-plane key can be minted without the instance issuing one
  // to itself (`HOGSEND_BOOTSTRAP_API_KEY` stays `false` above).
  if (context.ownerEmail) {
    vars.STUDIO_ADMIN_EMAIL = context.ownerEmail;
    vars.STUDIO_ADMIN_PASSWORD = args.studioAdminPassword;
  }

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
/**
 * Block until the managed hostname will actually serve HTTPS.
 *
 * This exists because of a live failure, not a hypothetical: the first real
 * provision attached the domain, published a correct CNAME, and marched on —
 * so `mint-credentials`, the first step to make an HTTPS call, hit a hostname
 * whose certificate was still `VALIDATING_OWNERSHIP` and died on "fetch
 * failed". Attaching a domain is instant; making it serve takes minutes, and
 * nothing downstream can tell the difference except by failing.
 *
 * Throws on exhaustion rather than falling back to the substrate URL. Falling
 * back would freeze `up.railway.app` into `API_PUBLIC_URL`, signed cookies and
 * every tracked link in every email that instance ever sends — permanently
 * recreating the two-hostname world this whole step exists to end, and doing it
 * for exactly the tenants unlucky enough to hit a slow certificate.
 */
async function waitForDomain(
  deps: ProvisionDeps,
  refs: StackRefs,
  hostname: string,
): Promise<{ attempts: number; waitedMs: number }> {
  const startedAt = deps.now();
  let delay = deps.healthPollBaseMs;
  let attempts = 0;

  for (;;) {
    attempts += 1;
    const attachment = await deps.substrate.checkDomain(refs, hostname);
    if (attachment.status === "verified") {
      return { attempts, waitedMs: deps.now() - startedAt };
    }

    const elapsed = deps.now() - startedAt;
    if (elapsed + delay > deps.domainDeadlineMs) {
      throw new Error(
        `${hostname} did not finish certificate issuance within ${Math.round(deps.domainDeadlineMs / 1000)}s after ${attempts} checks`,
      );
    }
    await deps.sleep(delay);
    delay = Math.min(delay * 2, DOMAIN_POLL_MAX_MS);
  }
}

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
