/**
 * A minimal browser fetch factory (mirrors `@hogsend/client`'s internal/http.ts
 * shape) with an auth-strategy seam: either browser-direct with a publishable
 * key, or BYO-proxy to the host app's backend (`ingestPath`). Throws the same
 * typed errors as `@hogsend/client` so consumers can `instanceof` either.
 */

import { HogsendAPIError, RateLimitError } from "../errors.js";

/** Query params — undefined values are dropped. */
export type Query = Record<string, string | number | undefined>;

const DEFAULT_TIMEOUT_MS = 30_000;

/** How requests authenticate to the data plane. */
export interface AuthStrategy {
  /** Engine origin for browser-direct requests. */
  baseUrl: string;
  /**
   * When set, telemetry POSTs go to this absolute URL (the host app's own
   * backend) instead of `baseUrl`. The proxy holds the secret key.
   */
  ingestPath?: string;
  /** Publishable key sent as `Authorization: Bearer pk_…` (browser-direct). */
  publishableKey: string;
  /**
   * Secure-mode refresh hook. Called AT MOST ONCE per request when a data-plane
   * call 403s with an expired/invalid-`userToken` signal: it must refresh the
   * token (e.g. re-hit the host server's mint route) and return the fresh token
   * (or null to give up). The transport then re-stamps the request body's
   * `userToken` from {@link AuthStrategy.getUserToken} and retries ONCE. A
   * second 403 throws (no infinite loop). A generic 403 (origin allowlist)
   * does NOT trigger this — refreshing won't fix an origin block.
   */
  onUnauthorized?: () => Promise<string | null>;
  /**
   * Reads the CURRENT `userToken` from the identity store. Used to re-stamp the
   * retried request body after {@link AuthStrategy.onUnauthorized} refreshes it,
   * so callers that built the body from a stale token need no changes.
   */
  getUserToken?: () => string | null;
}

/** Transport configuration. */
export interface TransportConfig {
  auth: AuthStrategy;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** A self-contained data-plane HTTP transport over native fetch. */
export interface Transport {
  get<T = unknown>(path: string, query?: Query): Promise<T>;
  post<T = unknown>(
    path: string,
    body: unknown,
    extras?: { idempotencyKey?: string },
  ): Promise<T>;
  put<T = unknown>(path: string, body: unknown): Promise<T>;
  /**
   * Best-effort fire-and-forget POST that survives page unload via
   * `navigator.sendBeacon` when available. Returns whether the beacon was
   * accepted by the browser; falls back to a keepalive fetch otherwise.
   */
  beacon(path: string, body: unknown): boolean;
}

function buildUrl(baseUrl: string, path: string, query?: Query): string {
  const url = new URL(path.startsWith("/") ? path : `/${path}`, `${baseUrl}/`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function bodyMessage(status: number, body: unknown): string {
  if (body && typeof body === "object") {
    const errField = (body as { error?: unknown }).error;
    if (typeof errField === "string") return `${status}: ${errField}`;
  }
  return `request failed with status ${status}`;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number.parseInt(value, 10);
  return Number.isFinite(seconds) ? seconds : undefined;
}

/**
 * Is this 403 specifically an expired/invalid `userToken` (vs a generic origin
 * block)? Match the engine's `{ error: "...userToken..." }` message defensively
 * (case-insensitive substring). FLAG: if the engine ever renames that error
 * string, the refresh signal silently stops (a generic 403 then surfaces) —
 * acceptable and documented.
 */
function isUserTokenSignal(status: number, body: unknown): boolean {
  if (status !== 403) return false;
  if (body && typeof body === "object") {
    const err = (body as { error?: unknown }).error;
    if (typeof err === "string") {
      return err.toLowerCase().includes("usertoken");
    }
  }
  return false;
}

/**
 * Re-stamp the request body's `userToken` from the freshly-refreshed token, so
 * a caller that built the body off a now-stale token retries with the new one
 * without any caller change. Only touches an object body carrying a `userToken`
 * key (the identity-asserting paths); everything else passes through untouched.
 */
function restampUserToken(body: unknown, fresh: string | null): unknown {
  if (
    fresh &&
    body &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    "userToken" in (body as Record<string, unknown>)
  ) {
    return { ...(body as Record<string, unknown>), userToken: fresh };
  }
  return body;
}

/**
 * Resolve the absolute URL for a telemetry POST. Ingest paths (`/v1/events`)
 * route to `ingestPath` when set (proxy mode); everything else is
 * browser-direct against `baseUrl`.
 */
function resolveTelemetryUrl(auth: AuthStrategy, path: string): string {
  if (auth.ingestPath && path.startsWith("/v1/events")) {
    return auth.ingestPath;
  }
  return buildUrl(auth.baseUrl, path);
}

/** Build a {@link Transport} bound to a config. */
export function createTransport(config: TransportConfig): Transport {
  const doFetch = config.fetch ?? fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { auth } = config;

  function authHeaders(): Record<string, string> {
    // In proxy mode the host backend supplies its own credentials; we still
    // send the publishable key as a hint, harmless to the proxy.
    return { Authorization: `Bearer ${auth.publishableKey}` };
  }

  /** One network attempt. Returns the parsed body + status (no throw on !ok). */
  async function attempt(
    method: string,
    url: string,
    opts: { body?: unknown; idempotencyKey?: string },
  ): Promise<{
    ok: boolean;
    status: number;
    parsed: unknown;
    retryAfter?: string | null;
  }> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...authHeaders(),
    };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res: Response;
    try {
      res = await doFetch(url, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      throw new HogsendAPIError(`cannot reach ${url} (${msg})`, 0, undefined);
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let parsed: unknown;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    return {
      ok: res.ok,
      status: res.status,
      parsed,
      retryAfter: res.headers.get("Retry-After"),
    };
  }

  function raise(
    status: number,
    parsed: unknown,
    retryAfter?: string | null,
  ): never {
    if (status === 429) {
      throw new RateLimitError(
        bodyMessage(status, parsed),
        parsed,
        parseRetryAfter(retryAfter ?? null),
      );
    }
    throw new HogsendAPIError(bodyMessage(status, parsed), status, parsed);
  }

  async function request<T>(
    method: string,
    url: string,
    opts: { body?: unknown; idempotencyKey?: string },
  ): Promise<T> {
    let r = await attempt(method, url, opts);

    // Secure-mode refresh-and-retry-once: a 403 carrying the expired-/invalid-
    // `userToken` signal triggers exactly one onUnauthorized() refresh + retry
    // with the body's `userToken` re-stamped. A `triedRefresh` guard caps it at
    // one retry — a second 403 falls through to `raise`.
    if (!r.ok && auth.onUnauthorized && isUserTokenSignal(r.status, r.parsed)) {
      const fresh = await auth.onUnauthorized();
      if (fresh) {
        const nextBody = restampUserToken(
          opts.body,
          auth.getUserToken?.() ?? fresh,
        );
        r = await attempt(method, url, { ...opts, body: nextBody });
      }
    }

    if (!r.ok) raise(r.status, r.parsed, r.retryAfter);
    return r.parsed as T;
  }

  return {
    get: <T>(path: string, query?: Query) =>
      request<T>("GET", buildUrl(auth.baseUrl, path, query), {}),
    post: <T>(
      path: string,
      body: unknown,
      extras?: { idempotencyKey?: string },
    ) =>
      request<T>("POST", resolveTelemetryUrl(auth, path), {
        body,
        idempotencyKey: extras?.idempotencyKey,
      }),
    put: <T>(path: string, body: unknown) =>
      request<T>("PUT", buildUrl(auth.baseUrl, path), { body }),
    beacon: (path: string, body: unknown) => {
      const url = resolveTelemetryUrl(auth, path);
      const payload = JSON.stringify(body);
      if (
        typeof navigator !== "undefined" &&
        typeof navigator.sendBeacon === "function"
      ) {
        const blob = new Blob([payload], { type: "application/json" });
        return navigator.sendBeacon(url, blob);
      }
      // Fallback: keepalive fetch (best-effort, ignore the promise).
      try {
        void doFetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: payload,
          keepalive: true,
        });
        return true;
      } catch {
        return false;
      }
    },
  };
}
