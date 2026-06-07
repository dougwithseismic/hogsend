import { HogsendAPIError, RateLimitError } from "../errors.js";

/** Query params accepted by `get` — undefined values are dropped. */
export type Query = Record<string, string | number | undefined>;

/** Per-request extras (currently just an idempotency header passthrough). */
export interface RequestExtras {
  /** Sent as the `Idempotency-Key` header when set. */
  idempotencyKey?: string;
}

export interface HttpClientConfig {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

/** A minimal, self-contained data-plane HTTP client over native fetch. */
export interface HttpClient {
  get<T = unknown>(path: string, query?: Query): Promise<T>;
  post<T = unknown>(
    path: string,
    body: unknown,
    extras?: RequestExtras,
  ): Promise<T>;
  put<T = unknown>(
    path: string,
    body: unknown,
    extras?: RequestExtras,
  ): Promise<T>;
  del<T = unknown>(path: string, body?: unknown): Promise<T>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

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
    // Application-handler envelope: `{ error: "human message" }`.
    const errField = (body as { error?: unknown }).error;
    if (typeof errField === "string") {
      return `${status}: ${errField}`;
    }
    // @hono/zod-openapi default-hook validation envelope:
    // `{ success: false, error: <ZodError> }` (no defaultHook configured). The
    // structured ZodError is preserved on `err.body`; surface a short, readable
    // summary for `err.message` instead of the generic fallback.
    if (
      (body as { success?: unknown }).success === false &&
      errField &&
      typeof errField === "object"
    ) {
      const summary = JSON.stringify(errField).slice(0, 200);
      return `${status}: validation failed ${summary}`;
    }
  }
  return `request failed with status ${status}`;
}

/** Parse a `Retry-After` header (seconds form) into a number, else undefined. */
function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number.parseInt(value, 10);
  return Number.isFinite(seconds) ? seconds : undefined;
}

/**
 * Builds an {@link HttpClient} bound to a config. Native `fetch`, JSON in/out,
 * `Authorization: Bearer <apiKey>`. Throws typed errors:
 *   - {@link RateLimitError} on 429 (with parsed `Retry-After`),
 *   - {@link HogsendAPIError} on any other non-2xx,
 *   - {@link HogsendAPIError} with `status === 0` on a transport failure
 *     (DNS/connect/abort/timeout).
 */
export function createHttpClient(config: HttpClientConfig): HttpClient {
  const doFetch = config.fetch ?? fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const extraHeaders = config.headers ?? {};

  async function request<T>(
    method: string,
    path: string,
    opts: { query?: Query; body?: unknown; extras?: RequestExtras },
  ): Promise<T> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${config.apiKey}`,
      ...extraHeaders,
    };
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (opts.extras?.idempotencyKey) {
      headers["Idempotency-Key"] = opts.extras.idempotencyKey;
    }

    const url = buildUrl(config.baseUrl, path, opts.query);

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
      throw new HogsendAPIError(
        `cannot reach ${config.baseUrl} (${msg})`,
        0,
        undefined,
      );
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
    get: <T>(path: string, query?: Query) => request<T>("GET", path, { query }),
    post: <T>(path: string, body: unknown, extras?: RequestExtras) =>
      request<T>("POST", path, { body, extras }),
    put: <T>(path: string, body: unknown, extras?: RequestExtras) =>
      request<T>("PUT", path, { body, extras }),
    del: <T>(path: string, body?: unknown) =>
      request<T>("DELETE", path, { body }),
  };
}
