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

/** Internal options accepted by the shared {@link request} core. */
interface RequestOpts {
  query?: Query;
  body?: unknown;
  /** When false, no Authorization header is sent (e.g. /v1/health). */
  auth: boolean;
}

/**
 * The single HTTP core, shared by the admin client and the data-plane client.
 * Bound to a `baseUrl` + a bearer `key`; the only difference between the two
 * clients is which key (and which "missing key" message) they carry. Sends
 * `Authorization: Bearer <key>` when `auth` is set, parses JSON, and throws an
 * {@link HttpError} on any non-2xx response (or transport failure).
 */
async function request<T>(
  baseUrl: string,
  key: string | undefined,
  missingKeyMessage: string,
  method: string,
  path: string,
  opts: RequestOpts,
): Promise<T> {
  if (opts.auth && !key) {
    throw makeHttpError(missingKeyMessage, 0, undefined);
  }

  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.auth && key) {
    headers.Authorization = `Bearer ${key}`;
  }
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const url = buildUrl(baseUrl, path, opts.query);

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    throw makeHttpError(`cannot reach ${baseUrl} (${msg})`, 0, undefined);
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

/** Build an {@link AdminClient} bound to the given resolved config. */
export function createAdminClient(cfg: ResolvedConfig): AdminClient {
  const missing =
    "no admin key configured — pass --admin-key, or set HOGSEND_ADMIN_KEY / ADMIN_API_KEY";
  return {
    cfg,
    get: <T>(path: string, query?: Query, extras?: RequestExtras) =>
      request<T>(cfg.baseUrl, cfg.adminKey, missing, "GET", path, {
        query,
        auth: extras?.auth ?? true,
      }),
    patch: <T>(path: string, body: unknown) =>
      request<T>(cfg.baseUrl, cfg.adminKey, missing, "PATCH", path, {
        body,
        auth: true,
      }),
    post: <T>(path: string, body: unknown) =>
      request<T>(cfg.baseUrl, cfg.adminKey, missing, "POST", path, {
        body,
        auth: true,
      }),
  };
}

/**
 * Thin data-plane HTTP client over the same core as {@link createAdminClient},
 * but bound to `cfg.dataKey` (an `ingest`-scoped key). Used by the write
 * commands (`contacts upsert`, `events send`, `emails send`) which hit the
 * authed `/v1/contacts`, `/v1/events`, and `/v1/emails` data-plane routes.
 *
 * Exposes the full read/write verb set the data plane needs: `get`/`post`/
 * `put`/`del`. Every call is authenticated (there is no unauthenticated
 * data-plane route), so there is no `{ auth: false }` escape hatch here.
 */
export interface DataPlaneClient {
  get<T = unknown>(path: string, query?: Query): Promise<T>;
  post<T = unknown>(path: string, body: unknown): Promise<T>;
  put<T = unknown>(path: string, body: unknown): Promise<T>;
  del<T = unknown>(path: string, body?: unknown): Promise<T>;
  /** The resolved config this client is bound to (for messages/JSON output). */
  readonly cfg: ResolvedConfig;
}

/** Build a {@link DataPlaneClient} bound to `cfg.dataKey`. */
export function createDataPlaneClient(cfg: ResolvedConfig): DataPlaneClient {
  const missing =
    "no data key configured — pass --data-key, or set HOGSEND_DATA_KEY / HOGSEND_API_KEY";
  return {
    cfg,
    get: <T>(path: string, query?: Query) =>
      request<T>(cfg.baseUrl, cfg.dataKey, missing, "GET", path, {
        query,
        auth: true,
      }),
    post: <T>(path: string, body: unknown) =>
      request<T>(cfg.baseUrl, cfg.dataKey, missing, "POST", path, {
        body,
        auth: true,
      }),
    put: <T>(path: string, body: unknown) =>
      request<T>(cfg.baseUrl, cfg.dataKey, missing, "PUT", path, {
        body,
        auth: true,
      }),
    del: <T>(path: string, body?: unknown) =>
      request<T>(cfg.baseUrl, cfg.dataKey, missing, "DELETE", path, {
        body,
        auth: true,
      }),
  };
}

export { isHttpError };
