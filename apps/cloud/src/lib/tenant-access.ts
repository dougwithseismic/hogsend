import { and, eq } from "drizzle-orm";
import type { CloudDb } from "../db";
import { db as defaultDb } from "../db";
import { environments, stacks } from "../db/schema";
import {
  failedProvisionStep,
  findOwnerEmail,
  type ProvisionStep,
  type StackSecrets,
} from "../pipeline/provision";
import {
  DEFAULT_PROVISION_ATTEMPT_CEILING,
  DEFAULT_PROVISION_STALE_AFTER_MS,
} from "../pipeline/provision-sweep";
import { writeAudit } from "../services/audit";
import { CloudServiceError, NotFoundError } from "../services/errors";
import type { StackRow } from "../services/orgs";
import type { StackStatus } from "../services/stacks";
import {
  resolveTenantCredentialClient,
  TENANT_INGEST_KEY_NAME,
  type TenantCredentialClient,
  TenantCredentialError,
  type TenantKeySummary,
  type TenantSession,
} from "../services/tenant-credentials";
import { decryptSecretPayload } from "./crypto";
import type { ProvisionStepView } from "./environment-detail";
import { assertCanOperateEnvironments } from "./environment-ops";
import type { OrgMembersDeps } from "./org-members";
import { readMemberContext } from "./org-members";
import { readStackRefs } from "./stack-refs";

/**
 * The customer's half of an environment: how they open their own Studio, the
 * credentials that get them in, and the keys their code sends with.
 *
 * The reads and every mutation live HERE rather than in the page or the server
 * actions above them, for the reason `environment-ops.ts` gives: a server
 * action is a POST endpoint anyone with a session can reach, so the rules have
 * to sit somewhere a test can call with a real session and no Next request.
 * Three rules, applied in this order by {@link resolveTenantAccess}, every
 * time:
 *
 *  1. the environment belongs to the CALLER's organization (scoped in the
 *     query, so a foreign id is indistinguishable from a made-up one);
 *  2. the caller may OPERATE environments — a plain member may look at an
 *     environment, not read the password that administers it;
 *  3. the stack is actually `running` with credentials minted, because there is
 *     nothing to reveal before that and a half-provisioned stack should say so
 *     rather than render an empty box.
 *
 * **On "revealed once".** PRD 13 T4 says the Studio password is "revealed
 * once". This module deliberately does NOT implement a one-time lock that
 * destroys the customer's ability to read it again: a customer who loses the
 * password before changing it would be locked out of their own product, with
 * the control plane holding the only copy and refusing to hand it over.
 * "Revealed once" is implemented as **hidden by default, revealed on an
 * explicit click** — repeated reveals are allowed, and every one writes an
 * audit row. The audit records THAT a reveal happened, never the secret.
 */

/** Audit actions written by this module. Read by the operator trail. */
export const REVEAL_STUDIO_PASSWORD_ACTION =
  "environment.studio_password.revealed";
export const REVEAL_INGEST_KEY_ACTION = "environment.ingest_key.revealed";
export const TENANT_KEY_CREATED_ACTION = "environment.api_key.created";
export const TENANT_KEY_REVOKED_ACTION = "environment.api_key.revoked";

/** The instance is not yet in a state that has credentials to show. */
export class TenantAccessUnavailableError extends CloudServiceError {
  readonly code = "tenant_access_unavailable";
}

/** The control plane's own key was named for revocation. */
export class ControlPlaneKeyError extends CloudServiceError {
  readonly code = "control_plane_key_protected";

  constructor() {
    super(
      `"${TENANT_INGEST_KEY_NAME}" is the key Hogsend Cloud minted for you and still holds a copy of. Revoking it here would break the snippet on this page and leave the control plane pointing at a dead credential. Create your own key, move your code onto it, then rotate this one from Studio.`,
    );
  }
}

/**
 * The instance refused the stored Studio password.
 *
 * Its own class because the REMEDY is completely different from every other
 * tenant-side failure, and rendering it as "your instance did not answer"
 * would send both the customer and our operator hunting an infrastructure
 * fault that does not exist. The only way this happens in practice is that the
 * password was changed (or reset) inside Studio: the engine closes public
 * sign-up (`packages/engine/src/lib/auth.ts`, `disableSignUp: true`), so this
 * admin is the only account the control plane has, and there is no second one
 * to fall back to.
 */
export class StudioPasswordRejectedError extends CloudServiceError {
  readonly code = "studio_password_rejected";

  constructor() {
    super(
      "Hogsend Cloud can no longer sign in to this instance — its Studio password was changed there, and this page signs in with the one we hold. Set it back to the password shown above, or ask us to re-issue it, and key management here starts working again.",
    );
  }
}

/** Studio is served by the engine at `<apiPublicUrl>/studio`. */
export function studioUrlFor(apiPublicUrl: string): string {
  return `${apiPublicUrl.replace(/\/+$/, "")}/studio`;
}

/**
 * The `.env` fragment a customer can paste into their own repo.
 *
 * Two lines, not one, and secret-key only: `@hogsend/client` reads
 * `HOGSEND_API_URL` for the instance and `HOGSEND_API_KEY` for the credential
 * (see `packages/create-hogsend/template/env.example` and the integrate skill).
 * The key is an `ingest`-scoped SECRET key and must stay server-side — browser
 * `pk_` keys are a different credential and are not issued from this page yet.
 */
export function ingestEnvSnippet(input: {
  apiUrl: string;
  apiKey: string;
}): string {
  return [
    `HOGSEND_API_URL=${input.apiUrl}`,
    `HOGSEND_API_KEY=${input.apiKey}`,
  ].join("\n");
}

/**
 * What the page says while a stack is not yet the customer's to use.
 *
 * `retrying` and `alerted` are claims about behaviour, so they are derived from
 * the sweeps' own constants (`provision-sweep.ts`, `alert-sweep.ts`) rather
 * than asserted by the copy: the page promises a retry only where the sweep
 * would actually re-drive, and promises a human only where the sweep has
 * stopped retrying and the alert sweep's `provision_exhausted` condition fires.
 */
export type ProvisionProgressState =
  | "not_started"
  | "working"
  | "retrying"
  | "alerted"
  | "stalled"
  | "ready"
  | "halted";

export interface ProvisionProgress {
  state: ProvisionProgressState;
  /** The step the run is on (or died on); null once running or with no stack. */
  step: ProvisionStep | null;
  /** How long it has been on that step; null when there is nothing to time. */
  since: Date | null;
  /** One plain-language line. Never a stack trace, never a bare error string. */
  message: string;
}

export interface ProvisionProgressInput {
  /** null when the environment has no stack row at all. */
  stack: {
    status: StackStatus;
    lastError: string | null;
    retryCount: number;
    updatedAt: Date;
  } | null;
  steps: ProvisionStepView[];
  now: Date;
  attemptCeiling?: number;
  staleAfterMs?: number;
}

/**
 * Pure, and the one place the page's provisioning copy is decided.
 *
 * Extracted rather than inlined in the component so the three states that are
 * hard to reach in a browser — a stale `provisioning` row, a re-drivable
 * `error`, an exhausted one — are assertable.
 */
export function deriveProvisionProgress(
  input: ProvisionProgressInput,
): ProvisionProgress {
  const ceiling = input.attemptCeiling ?? DEFAULT_PROVISION_ATTEMPT_CEILING;
  const staleAfterMs = input.staleAfterMs ?? DEFAULT_PROVISION_STALE_AFTER_MS;
  const stack = input.stack;

  if (!stack) {
    return {
      state: "not_started",
      step: null,
      since: null,
      message:
        "This environment has no stack yet. Provisioning starts as soon as one is enqueued.",
    };
  }

  // Nothing has been asked for yet (PRD 15). `not_started` already means
  // exactly that — "no substrate work is in flight and none is coming until
  // something starts it" — so `deferred` reuses it rather than adding a state
  // every consumer would have to learn. What changes is the sentence: the
  // thing that starts it is the customer's own first publish.
  if (stack.status === "deferred") {
    return {
      state: "not_started",
      step: null,
      since: stack.updatedAt,
      message:
        "This instance is built on your first `hogsend publish` — nothing is provisioning yet, and nothing is wrong.",
    };
  }

  const failed = input.steps.find((entry) => entry.state === "failed") ?? null;
  const pending =
    input.steps.find((entry) => entry.state === "pending") ?? null;
  // `last_error` first: it is written on the stack row by the same call that
  // parked it, so it names the failed step even before (or without) the audit
  // row the step derivation reads.
  const errorStep = failedProvisionStep(stack.lastError);
  const step = errorStep ?? failed?.step ?? pending?.step ?? null;
  const since = failed?.at ?? stack.updatedAt;

  // Reached from two conditions — a parked `error` and a `provisioning` row
  // that has gone silent — and it is one sentence a customer reads, so it is
  // written once.
  const alerted = (): ProvisionProgress => ({
    state: "alerted",
    step,
    since,
    message: `We retried this ${stack.retryCount} times and stopped. A human at Hogsend has been alerted; you do not need to do anything.`,
  });

  if (stack.status === "running") {
    return {
      state: "ready",
      step: null,
      since: stack.updatedAt,
      message: "This instance is running.",
    };
  }

  if (
    stack.status === "suspended" ||
    stack.status === "destroying" ||
    stack.status === "destroyed"
  ) {
    return {
      state: "halted",
      step: null,
      since: stack.updatedAt,
      message:
        "This environment was stopped deliberately, so nothing is provisioning it.",
    };
  }

  if (stack.status === "error") {
    // Only a failure INSIDE the provisioning pipeline is re-driven; a stack
    // parked by a failed publish has an image problem and the sweep leaves it
    // alone, so promising a retry there would be a lie.
    if (!errorStep) {
      return {
        state: "stalled",
        step,
        since,
        message:
          "This stack stopped outside provisioning, so nothing retries it automatically. Use Retry below, or contact us.",
      };
    }
    if (stack.retryCount >= ceiling) {
      return alerted();
    }
    return {
      state: "retrying",
      step,
      since,
      message:
        "This step did not complete. We are retrying it automatically every few minutes — provisioning resumes from where it stopped, it does not start over.",
    };
  }

  // `requested` or `provisioning`. A row that has been silent longer than the
  // sweep's stale window is one the sweep will pick up on its next tick; a
  // fresher one is simply still working.
  const silentFor = input.now.getTime() - stack.updatedAt.getTime();
  if (silentFor >= staleAfterMs) {
    if (stack.retryCount >= ceiling) {
      return alerted();
    }
    return {
      state: "retrying",
      step,
      since,
      message:
        "This step has been quiet longer than it should be. We are picking it up automatically and resuming from where it stopped.",
    };
  }

  return {
    state: "working",
    step,
    since,
    message:
      "Provisioning is running. Each step is one piece of your instance — database, worker, API, then your Studio login.",
  };
}

export interface TenantAccessDeps extends OrgMembersDeps {
  db?: CloudDb;
  /** Injected so a test drives key management without an engine listening. */
  credentials?: TenantCredentialClient;
}

/** What the page renders above the infrastructure rows. Never a secret. */
export interface TenantAccessView {
  environmentId: string;
  /** True only when Studio and the keys are actually usable. */
  ready: boolean;
  /** `<apiPublicUrl>/studio`, or null before the substrate issued a URL. */
  studioUrl: string | null;
  apiUrl: string | null;
  /** The Studio admin the pipeline created — the org owner's own address. */
  adminEmail: string | null;
  /** Whether this caller may reveal secrets and manage keys. */
  canReveal: boolean;
  /** The caller's role, so the page can explain a refusal rather than hide it. */
  role: string;
  /** The name of the key the control plane minted and still holds. */
  controlPlaneKeyName: string;
}

/**
 * A caller that has already been identified, with the tenancy and the role the
 * gate below needs and nothing else.
 *
 * The reason this type exists: the SAME credential-release rules are reached
 * from two doors. The dashboard resolves a browser session
 * (`readMemberContext`); `GET /api/cli/environments/:id/credentials` resolves a
 * `hogsend login` CLI session (`lib/cli-auth.ts`). Identity resolution is the
 * ONLY difference between them — the tenancy scope, the operator-role check,
 * the readiness check, the decrypt and the audit write are identical, and two
 * copies of a credential-release gate is how one of them silently loses a
 * check. So the gate takes a resolved caller and both doors pass through it.
 */
export interface TenantCaller {
  organizationId: string;
  userId: string;
  role: string;
}

interface ResolvedAccess {
  organizationId: string;
  userId: string;
  role: string;
  stack: StackRow;
  apiUrl: string;
  adminEmail: string;
  secrets: StackSecrets;
  db: CloudDb;
  client: TenantCredentialClient;
}

/** The environment + its stack, scoped to an already-resolved caller's org. */
async function loadEnvironmentForCaller(
  context: TenantCaller,
  environmentId: string,
  deps: TenantAccessDeps,
): Promise<{ context: TenantCaller; stack: StackRow | null } | null> {
  const db = deps.db ?? defaultDb;

  const [row] = await db
    .select({ environment: environments, stack: stacks })
    .from(environments)
    .leftJoin(stacks, eq(stacks.environmentId, environments.id))
    .where(
      and(
        eq(environments.id, environmentId),
        eq(environments.organizationId, context.organizationId),
      ),
    )
    .limit(1);
  if (!row) return null;
  return { context, stack: row.stack };
}

/** The same, for a browser session: resolve the caller, then scope. */
async function loadOwnEnvironment(
  headers: Headers,
  environmentId: string,
  deps: TenantAccessDeps,
): Promise<{ context: TenantCaller; stack: StackRow | null } | null> {
  const context = await readMemberContext(headers, deps);
  return loadEnvironmentForCaller(context, environmentId, deps);
}

/**
 * Everything the customer-facing block needs, with no secret in it.
 *
 * Returns null on the same condition `readEnvironmentDetail` does, so the page
 * turns a foreign id into the same 404 twice rather than once.
 */
export async function readTenantAccess(
  headers: Headers,
  input: { environmentId: string },
  deps: TenantAccessDeps = {},
): Promise<TenantAccessView | null> {
  const loaded = await loadOwnEnvironment(headers, input.environmentId, deps);
  if (!loaded) return null;

  const { context, stack } = loaded;
  const refs = stack ? readStackRefs(stack) : null;
  const minted =
    (stack?.substrateRefs as Record<string, unknown> | null)
      ?.credentialsMinted === true;

  return {
    environmentId: input.environmentId,
    ready: stack?.status === "running" && minted && Boolean(refs),
    studioUrl: refs ? studioUrlFor(refs.apiPublicUrl) : null,
    apiUrl: refs?.apiPublicUrl ?? null,
    adminEmail: stack
      ? await findOwnerEmail(deps.db ?? defaultDb, stack.organizationId)
      : null,
    canReveal: (() => {
      try {
        assertCanOperateEnvironments(context.role);
        return true;
      } catch {
        return false;
      }
    })(),
    role: context.role,
    controlPlaneKeyName: TENANT_INGEST_KEY_NAME,
  };
}

/**
 * The gate every reveal and every key mutation passes through.
 *
 * Order matters and is the same as `environment-ops.ts`': tenancy scope first
 * (so a foreign id reads as "not found" and leaks nothing), then the operator
 * role, then the stack's own readiness.
 */
async function resolveTenantAccessFor(
  caller: TenantCaller,
  input: { environmentId: string },
  deps: TenantAccessDeps,
): Promise<ResolvedAccess> {
  const db = deps.db ?? defaultDb;
  const loaded = await loadEnvironmentForCaller(
    caller,
    input.environmentId,
    deps,
  );
  if (!loaded) throw new NotFoundError("Environment", input.environmentId);

  assertCanOperateEnvironments(loaded.context.role);

  const stack = loaded.stack;
  if (!stack) {
    throw new TenantAccessUnavailableError(
      "This environment has no stack yet, so there are no credentials to show.",
    );
  }
  const refs = readStackRefs(stack);
  const minted =
    (stack.substrateRefs as Record<string, unknown> | null)
      ?.credentialsMinted === true;
  if (!refs || !minted || stack.status !== "running") {
    throw new TenantAccessUnavailableError(
      "This instance is still being set up. Its Studio login and API key appear here as soon as provisioning finishes.",
    );
  }

  // Absent only for a stack provisioned before the secret existed, which the
  // provision sweep re-drives. Refuse rather than render an empty credential.
  const secrets = stack.stackSecretsEncrypted
    ? decryptSecretPayload<StackSecrets>(stack.stackSecretsEncrypted)
    : null;
  if (!secrets?.studioAdminPassword) {
    throw new TenantAccessUnavailableError(
      "This instance has no stored Studio password yet. Hogsend Cloud is re-running that step; check back shortly.",
    );
  }

  const adminEmail = await findOwnerEmail(db, stack.organizationId);
  if (!adminEmail) {
    throw new TenantAccessUnavailableError(
      "This organization has no member to be the Studio admin.",
    );
  }

  return {
    organizationId: loaded.context.organizationId,
    userId: loaded.context.userId,
    role: loaded.context.role,
    stack,
    apiUrl: refs.apiPublicUrl,
    adminEmail,
    secrets,
    db,
    client: deps.credentials ?? resolveTenantCredentialClient(),
  };
}

/** The browser door onto {@link resolveTenantAccessFor}. */
async function resolveTenantAccess(
  headers: Headers,
  input: { environmentId: string },
  deps: TenantAccessDeps,
): Promise<ResolvedAccess> {
  const context = await readMemberContext(headers, deps);
  return resolveTenantAccessFor(context, input, deps);
}

/**
 * Sign in to a tenant instance as the admin the control plane holds.
 *
 * The ONE place `client.signIn` is called, so a rejected credential is
 * diagnosed once rather than at three call sites. A 401/403 is the instance
 * saying "that is not the password" — a fact about our stored copy, not about
 * the instance's health — and it becomes {@link StudioPasswordRejectedError}.
 * Anything else (a timeout, a 502, a body that is not JSON) travels on as the
 * transport failure it is.
 */
async function signInToTenant(access: ResolvedAccess): Promise<TenantSession> {
  try {
    return await access.client.signIn({
      baseUrl: access.apiUrl,
      email: access.adminEmail,
      password: access.secrets.studioAdminPassword,
    });
  } catch (error) {
    if (
      error instanceof TenantCredentialError &&
      (error.status === 401 || error.status === 403)
    ) {
      throw new StudioPasswordRejectedError();
    }
    throw error;
  }
}

/**
 * The Studio sign-in, revealed.
 *
 * Repeatable on purpose (see the module comment). The audit row names the
 * actor and the stack and carries NO secret — an audit trail that quoted the
 * password would be a second, permanent copy of it in a table more people can
 * read than can reach this page.
 */
export async function revealStudioPassword(
  headers: Headers,
  input: { environmentId: string },
  deps: TenantAccessDeps = {},
): Promise<{ email: string; password: string; studioUrl: string }> {
  const access = await resolveTenantAccess(headers, input, deps);
  await writeAudit(access.db, {
    actor: access.userId,
    organizationId: access.organizationId,
    action: REVEAL_STUDIO_PASSWORD_ACTION,
    subject: access.stack.id,
    detail: { environmentId: input.environmentId },
  });
  return {
    email: access.adminEmail,
    password: access.secrets.studioAdminPassword,
    studioUrl: studioUrlFor(access.apiUrl),
  };
}

/**
 * The paste-ready `.env` fragment, with the control-plane-minted key in it.
 *
 * The key material is the copy the control plane stored at mint time — the
 * instance itself cannot hand it back, by design. Same reveal-and-audit posture
 * as the password.
 */
export async function revealIngestSnippet(
  headers: Headers,
  input: { environmentId: string },
  deps: TenantAccessDeps = {},
): Promise<{ snippet: string; apiUrl: string }> {
  const context = await readMemberContext(headers, deps);
  const revealed = await revealIngestCredentials(context, input, deps);
  return {
    snippet: ingestEnvSnippet(revealed),
    apiUrl: revealed.apiUrl,
  };
}

/**
 * The instance URL and the control-plane-minted ingest key, released to an
 * already-identified caller.
 *
 * THE gate for this credential, for every door — the dashboard's
 * {@link revealIngestSnippet} and `hogsend env pull`'s
 * `GET /api/cli/environments/:id/credentials` both land here, so a check
 * removed from it is removed from both rather than from one silently.
 *
 * The key material is the copy the control plane stored at mint time — the
 * instance itself cannot hand it back, by design. The audit row names the actor
 * and the stack and carries the key's ID, never the key.
 */
export async function revealIngestCredentials(
  caller: TenantCaller,
  input: { environmentId: string },
  deps: TenantAccessDeps = {},
): Promise<{ apiUrl: string; apiKey: string }> {
  const access = await resolveTenantAccessFor(caller, input, deps);
  const apiKey = access.secrets.ingestApiKey;
  if (!apiKey) {
    throw new TenantAccessUnavailableError(
      "This instance has no stored API key yet. Create one below, or wait for Hogsend Cloud to finish minting it.",
    );
  }
  await writeAudit(access.db, {
    actor: access.userId,
    organizationId: access.organizationId,
    action: REVEAL_INGEST_KEY_ACTION,
    subject: access.stack.id,
    detail: {
      environmentId: input.environmentId,
      apiKeyId: access.secrets.ingestApiKeyId ?? null,
    },
  });
  return { apiUrl: access.apiUrl, apiKey };
}

/** One key as the page lists it. Never carries key material — the list route
 * on the instance does not return any, which is correct. */
export interface TenantKeyView {
  id: string;
  name: string;
  revokedAt: string | null;
  /** True for the key Hogsend Cloud minted and still holds a copy of. */
  controlPlane: boolean;
}

/**
 * The live key list, read from the tenant instance itself.
 *
 * Returns an `error` STRING rather than throwing, because this read happens
 * while rendering a page: the instance is a separate machine that can be down,
 * and a page that 500s because a key list timed out would take the rest of the
 * environment's status down with it.
 */
export async function readTenantKeys(
  headers: Headers,
  input: { environmentId: string },
  deps: TenantAccessDeps = {},
): Promise<{ keys: TenantKeyView[]; error: string | null }> {
  try {
    const access = await resolveTenantAccess(headers, input, deps);
    const session = await signInToTenant(access);
    const keys = await access.client.listKeys({
      baseUrl: access.apiUrl,
      session,
    });
    return { keys: keys.map((key) => toKeyView(key)), error: null };
  } catch (error) {
    return { keys: [], error: tenantErrorMessage(error) };
  }
}

function toKeyView(key: TenantKeySummary): TenantKeyView {
  return {
    id: key.id,
    name: key.name,
    revokedAt: key.revokedAt,
    controlPlane: key.name === TENANT_INGEST_KEY_NAME,
  };
}

/**
 * A tenant instance that did not answer is a fact about their instance, not a
 * bug report: the caller gets a sentence, and the underlying message (which can
 * quote a URL or a status) stays in the server log.
 */
export function tenantErrorMessage(error: unknown): string {
  if (error instanceof TenantAccessUnavailableError) return error.message;
  if (error instanceof ControlPlaneKeyError) return error.message;
  if (error instanceof StudioPasswordRejectedError) return error.message;
  if (error instanceof NotFoundError) return error.message;
  if (error instanceof Error && error.name === "NotPermittedError") {
    return error.message;
  }
  if (error instanceof CloudServiceError) {
    // A `TenantCredentialError` — the instance refused, timed out or answered
    // with something that is not JSON. The status stays in the log.
    console.error("[cloud] tenant instance call failed:", error);
    return "Your instance did not answer. It may be restarting — try again in a moment.";
  }
  // Never rethrown: this runs inside a page render and inside a server action,
  // and neither should turn a tenant-side hiccup into a 500.
  console.error("[cloud] tenant access failed:", error);
  return "Something went wrong reading this instance. Try again in a moment.";
}

/**
 * Mint a key on the customer's own instance.
 *
 * `ingest` scope only, matching `TENANT_INGEST_KEY_SCOPES` — the credential
 * client hard-codes it, so there is no path from this page to an admin-scoped
 * key. The full key comes back exactly once because the instance stores only a
 * hash of it; that IS genuinely one-time, unlike the Studio password.
 */
export async function createTenantKey(
  headers: Headers,
  input: { environmentId: string; name: string },
  deps: TenantAccessDeps = {},
): Promise<{ id: string; key: string }> {
  const access = await resolveTenantAccess(headers, input, deps);
  if (input.name === TENANT_INGEST_KEY_NAME) {
    // The name is the only handle the provisioner has on its own key
    // (`mintTenantCredentials`), and a second key under it would be revoked as
    // an orphan on the next sweep — a credential that dies without warning.
    throw new ControlPlaneKeyError();
  }

  const session = await signInToTenant(access);
  const created = await access.client.createKey({
    baseUrl: access.apiUrl,
    session,
    name: input.name,
  });
  await writeAudit(access.db, {
    actor: access.userId,
    organizationId: access.organizationId,
    action: TENANT_KEY_CREATED_ACTION,
    subject: access.stack.id,
    // The id and the name. Never `created.key`.
    detail: {
      environmentId: input.environmentId,
      apiKeyId: created.id,
      name: input.name,
    },
  });
  return created;
}

/**
 * Revoke a key on the customer's own instance.
 *
 * The control-plane key is refused, and the refusal is checked against the
 * INSTANCE's list rather than the name posted by the form: the id is what a
 * browser sends, and mapping it back through the live list is the only way to
 * know what it is called.
 */
export async function revokeTenantKey(
  headers: Headers,
  input: { environmentId: string; keyId: string },
  deps: TenantAccessDeps = {},
): Promise<{ keyId: string }> {
  const access = await resolveTenantAccess(headers, input, deps);
  const session = await signInToTenant(access);

  if (input.keyId === access.secrets.ingestApiKeyId)
    throw new ControlPlaneKeyError();
  const live = await access.client.listKeys({
    baseUrl: access.apiUrl,
    session,
  });
  const target = live.find((key) => key.id === input.keyId);
  if (!target) throw new NotFoundError("API key", input.keyId);
  if (target.name === TENANT_INGEST_KEY_NAME) throw new ControlPlaneKeyError();

  await access.client.revokeKey({
    baseUrl: access.apiUrl,
    session,
    keyId: input.keyId,
  });
  await writeAudit(access.db, {
    actor: access.userId,
    organizationId: access.organizationId,
    action: TENANT_KEY_REVOKED_ACTION,
    subject: access.stack.id,
    detail: {
      environmentId: input.environmentId,
      apiKeyId: input.keyId,
      name: target.name,
    },
  });
  return { keyId: input.keyId };
}
