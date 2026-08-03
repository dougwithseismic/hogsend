import { CloudServiceError } from "./errors";

/**
 * The control plane's client for a TENANT instance's own admin API.
 *
 * The `mint-credentials` provisioning step has to obtain a data-plane API key
 * for a stack it has just booted. It cannot import `@hogsend/engine` to do it:
 * the engine validates its env at import time and demands a `DATABASE_URL`,
 * which would throw inside the control plane. It also cannot write better-auth
 * rows by raw SQL — `packages/engine/src/lib/create-admin.ts` deliberately
 * refuses a raw password write, and duplicating its scrypt handling in a second
 * codebase would rot.
 *
 * So the control plane drives the instance the way any other operator would:
 * over HTTP, as the admin the instance minted for itself on boot from
 * `STUDIO_ADMIN_EMAIL` / `STUDIO_ADMIN_PASSWORD` (both set by `set-env`).
 *
 * The interface is a seam rather than a bare `fetch` because the fake substrate
 * hosts no engine at all: local dev and every control-plane test point at a URL
 * nothing answers on, and the pipeline still has to be exercisable end to end.
 *
 * NOTHING here logs. A session cookie, a password and a minted key all pass
 * through this module, and an error message that quoted a response body would
 * be the one place a key could leak into the trail.
 */

/**
 * The name every control-plane-minted key carries.
 *
 * STABLE on purpose: it is what makes a retry deterministic. A run that minted
 * a key and then failed to persist it leaves a live credential nobody holds,
 * and the only way to recognise that orphan on the next attempt is a name we
 * chose. Anything the customer creates later has a different name and is never
 * touched.
 */
export const TENANT_INGEST_KEY_NAME = "hogsend-cloud-ingest";

/** The scopes the minted key carries — ingest only, never admin. */
export const TENANT_INGEST_KEY_SCOPES = ["ingest"];

/** How long any single call to a tenant instance may take. */
const REQUEST_TIMEOUT_MS = 15_000;

/** Any failure of the credential flow against a tenant instance. */
export class TenantCredentialError extends CloudServiceError {
  readonly code = "tenant_credentials_failed";
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

/** An authenticated session against one tenant instance. Opaque to callers. */
export interface TenantSession {
  readonly cookie: string;
}

/** One key as the instance's admin API lists it. Never carries key material. */
export interface TenantKeySummary {
  id: string;
  name: string;
  /** Null while the key is live. */
  revokedAt: string | null;
}

/** A freshly minted key. `key` is returned exactly once, by the instance. */
export interface TenantMintedKey {
  id: string;
  key: string;
}

export interface TenantCredentialClient {
  signIn(args: {
    baseUrl: string;
    email: string;
    password: string;
  }): Promise<TenantSession>;
  listKeys(args: {
    baseUrl: string;
    session: TenantSession;
  }): Promise<TenantKeySummary[]>;
  createKey(args: {
    baseUrl: string;
    session: TenantSession;
    name: string;
  }): Promise<TenantMintedKey>;
  revokeKey(args: {
    baseUrl: string;
    session: TenantSession;
    keyId: string;
  }): Promise<void>;
}

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

async function call(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  what: string,
): Promise<Response> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new TenantCredentialError(
      `${what} could not reach the instance: ${message}`,
    );
  }
  if (!res.ok) {
    // The status only. A tenant error body can echo the request, and this
    // request carries a password.
    throw new TenantCredentialError(
      `${what} failed with HTTP ${res.status}`,
      res.status,
    );
  }
  return res;
}

async function readJson<T>(res: Response, what: string): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch {
    throw new TenantCredentialError(`${what} returned a body that is not JSON`);
  }
}

/**
 * The real client. Talks to the engine routes as they are today:
 * better-auth's `POST /api/auth/sign-in/email` for the session cookie, and the
 * `/v1/admin/api-keys` router (`packages/engine/src/routes/admin/api-keys.ts`)
 * for list, create and revoke.
 */
export function createHttpTenantCredentialClient(
  fetchImpl: typeof fetch = fetch,
): TenantCredentialClient {
  return {
    async signIn({ baseUrl, email, password }) {
      const res = await call(
        fetchImpl,
        `${trimBase(baseUrl)}/api/auth/sign-in/email`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, password }),
        },
        "Studio sign-in",
      );
      const cookie = res.headers
        .getSetCookie()
        .map((entry) => entry.split(";")[0])
        .filter((entry): entry is string => Boolean(entry))
        .join("; ");
      if (!cookie) {
        throw new TenantCredentialError(
          "Studio sign-in returned no session cookie",
        );
      }
      return { cookie };
    },

    async listKeys({ baseUrl, session }) {
      const res = await call(
        fetchImpl,
        `${trimBase(baseUrl)}/v1/admin/api-keys?limit=100&includeRevoked=false`,
        { method: "GET", headers: { cookie: session.cookie } },
        "API key list",
      );
      const body = await readJson<{ keys?: TenantKeySummary[] }>(
        res,
        "API key list",
      );
      return (body.keys ?? []).map((key) => ({
        id: key.id,
        name: key.name,
        revokedAt: key.revokedAt ?? null,
      }));
    },

    async createKey({ baseUrl, session, name }) {
      const res = await call(
        fetchImpl,
        `${trimBase(baseUrl)}/v1/admin/api-keys`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: session.cookie,
          },
          body: JSON.stringify({ name, scopes: TENANT_INGEST_KEY_SCOPES }),
        },
        "API key create",
      );
      const body = await readJson<{ id?: string; key?: string }>(
        res,
        "API key create",
      );
      if (!body.id || !body.key) {
        throw new TenantCredentialError(
          "API key create returned no key material",
        );
      }
      return { id: body.id, key: body.key };
    },

    async revokeKey({ baseUrl, session, keyId }) {
      await call(
        fetchImpl,
        `${trimBase(baseUrl)}/v1/admin/api-keys/${keyId}`,
        { method: "DELETE", headers: { cookie: session.cookie } },
        "API key revoke",
      );
    },
  };
}

/**
 * The in-memory client, for the fake substrate: local dev and the control-plane
 * test suite, where there is no engine listening on `apiPublicUrl`.
 *
 * Deterministic in the same way `FakeSubstrate` is — no clock, no randomness.
 * Key ids and key material derive from the instance URL and a per-URL counter,
 * so a test asserting a value is asserting a fact. It models the ONE property
 * the pipeline depends on: a revoked key stays listed as revoked, and a live
 * key stays live, so a second run can see what the first one left behind.
 */
export function createFakeTenantCredentialClient(): TenantCredentialClient {
  return buildFakeClient();
}

/**
 * The process-wide fake, for the same reason `getSubstrate()` keeps one
 * `FakeSubstrate`: its whole state is in memory, so a fresh instance per
 * pipeline run would forget the key the previous run minted and the step would
 * stop being idempotent exactly where it matters most.
 */
let fakeSingleton: TenantCredentialClient | undefined;

export function getFakeTenantCredentialClient(): TenantCredentialClient {
  fakeSingleton ??= buildFakeClient();
  return fakeSingleton;
}

function buildFakeClient(): TenantCredentialClient {
  const keysByUrl = new Map<string, TenantKeySummary[]>();
  const counters = new Map<string, number>();

  const keysFor = (baseUrl: string): TenantKeySummary[] => {
    const existing = keysByUrl.get(baseUrl);
    if (existing) return existing;
    const fresh: TenantKeySummary[] = [];
    keysByUrl.set(baseUrl, fresh);
    return fresh;
  };

  return {
    async signIn({ baseUrl, email }) {
      return { cookie: `fake-session=${encodeURIComponent(email)}@${baseUrl}` };
    },
    async listKeys({ baseUrl }) {
      return keysFor(baseUrl).filter((key) => key.revokedAt === null);
    },
    async createKey({ baseUrl, name }) {
      const next = (counters.get(baseUrl) ?? 0) + 1;
      counters.set(baseUrl, next);
      const id = `fake-key-${next}`;
      keysFor(baseUrl).push({ id, name, revokedAt: null });
      return { id, key: `hsk_fake_${next}` };
    },
    async revokeKey({ baseUrl, keyId }) {
      const key = keysFor(baseUrl).find((entry) => entry.id === keyId);
      if (key) key.revokedAt = "revoked";
    },
  };
}
