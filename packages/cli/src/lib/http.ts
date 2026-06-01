import type { ResolvedConfig } from "./config.js";

/** A non-2xx response (or transport failure) from the admin API. */
export interface HttpError extends Error {
  /** HTTP status code, or 0 for a transport-level failure (DNS/connect). */
  status: number;
  /** Parsed JSON body when available, else the raw text, else undefined. */
  body: unknown;
}

/** Query params accepted by `get` — undefined values are dropped. */
export type Query = Record<string, string | number | undefined>;

/**
 * Thin admin HTTP client over native fetch (Node 22). Hits `<base>/v1/...`,
 * sends `Authorization: Bearer <adminKey>` on admin paths, parses JSON, and
 * throws an {@link HttpError} on any non-2xx response.
 *
 * Path convention: pass the path AFTER the base URL, e.g. `/v1/admin/journeys`
 * or `/v1/health`. The unauthenticated health route is reached via the same
 * `get` — pass `{ auth: false }` so a missing admin key doesn't error.
 */
export interface AdminClient {
  get<T = unknown>(
    path: string,
    query?: Query,
    opts?: RequestExtras,
  ): Promise<T>;
  patch<T = unknown>(path: string, body: unknown): Promise<T>;
  post<T = unknown>(path: string, body: unknown): Promise<T>;
  /** The resolved config this client is bound to (for messages/JSON output). */
  readonly cfg: ResolvedConfig;
}

/** Per-request overrides. */
export interface RequestExtras {
  /** Set false for unauthenticated routes (e.g. /v1/health). Default true. */
  auth?: boolean;
}

function isHttpError(value: unknown): value is HttpError {
  return value instanceof Error && "status" in value;
}

function makeHttpError(
  message: string,
  status: number,
  body: unknown,
): HttpError {
  const err = new Error(message) as HttpError;
  err.name = "HttpError";
  err.status = status;
  err.body = body;
  return err;
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
  if (
    body &&
    typeof body === "object" &&
    "error" in body &&
    typeof (body as { error: unknown }).error === "string"
  ) {
    return `${status}: ${(body as { error: string }).error}`;
  }
  return `request failed with status ${status}`;
}

/** Build an {@link AdminClient} bound to the given resolved config. */
export function createAdminClient(cfg: ResolvedConfig): AdminClient {
  async function request<T>(
    method: string,
    path: string,
    opts: { query?: Query; body?: unknown; auth: boolean },
  ): Promise<T> {
    if (opts.auth && !cfg.adminKey) {
      throw makeHttpError(
        "no admin key configured — pass --admin-key, or set HOGSEND_ADMIN_KEY / ADMIN_API_KEY",
        0,
        undefined,
      );
    }

    const headers: Record<string, string> = { Accept: "application/json" };
    if (opts.auth && cfg.adminKey) {
      headers.Authorization = `Bearer ${cfg.adminKey}`;
    }
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const url = buildUrl(cfg.baseUrl, path, opts.query);

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      throw makeHttpError(`cannot reach ${cfg.baseUrl} (${msg})`, 0, undefined);
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
      throw makeHttpError(bodyMessage(res.status, parsed), res.status, parsed);
    }

    return parsed as T;
  }

  return {
    cfg,
    get: <T>(path: string, query?: Query, extras?: RequestExtras) =>
      request<T>("GET", path, { query, auth: extras?.auth ?? true }),
    patch: <T>(path: string, body: unknown) =>
      request<T>("PATCH", path, { body, auth: true }),
    post: <T>(path: string, body: unknown) =>
      request<T>("POST", path, { body, auth: true }),
  };
}

export { isHttpError };
