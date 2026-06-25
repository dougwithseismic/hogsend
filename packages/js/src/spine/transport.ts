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

  async function request<T>(
    method: string,
    url: string,
    opts: { body?: unknown; idempotencyKey?: string },
  ): Promise<T> {
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

    if (!res.ok) {
      if (res.status === 429) {
        throw new RateLimitError(
          bodyMessage(res.status, parsed),
          parsed,
          parseRetryAfter(res.headers.get("Retry-After")),
        );
      }
      throw new HogsendAPIError(
        bodyMessage(res.status, parsed),
        res.status,
        parsed,
      );
    }

    return parsed as T;
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
