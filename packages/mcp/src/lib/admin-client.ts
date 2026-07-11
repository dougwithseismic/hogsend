/**
 * Minimal admin HTTP client for the `@hogsend/mcp` tools.
 *
 * Adapted from `packages/cli/src/lib/http.ts`'s request core (HttpError with
 * status + parsed body, JSON-parse-with-text-fallback, undefined-dropping query
 * builder, bearer auth) MINUS the CLI's `ResolvedConfig`/data-plane coupling.
 * Every tool talks to the admin REST API through this interface, so the exact
 * same code path serves both the stdio bin (real `fetch`) and Phase 3's hosted
 * transport (an in-process `app.request()` client) — one tool implementation,
 * one auth story.
 *
 * The bearer key is NEVER placed in a URL (spec-banned; leaks into logs) — it
 * only ever rides the `Authorization` header.
 */

/** Query params accepted by `get` — `undefined` values are dropped. */
export type Query = Record<string, string | number | boolean | undefined>;

/** A non-2xx response (or transport failure) from the admin API. */
export interface HttpError extends Error {
  /** HTTP status code, or 0 for a transport-level failure (DNS/connect). */
  status: number;
  /** Parsed JSON body when available, else the raw text, else undefined. */
  body: unknown;
}

/**
 * The verb surface the tools use. Deliberately tiny — just `get/post/patch`,
 * each generic in its response type. No `put`/`del` (no tool needs them, and
 * Phase 3's in-process adapter shouldn't have to implement dead verbs), no
 * per-call auth escape hatch (every admin route is authenticated).
 */
export interface AdminClient {
  get<T = unknown>(path: string, query?: Query): Promise<T>;
  post<T = unknown>(path: string, body?: unknown): Promise<T>;
  patch<T = unknown>(path: string, body?: unknown): Promise<T>;
}

export function isHttpError(value: unknown): value is HttpError {
  return value instanceof Error && "status" in value;
}

/** Read `body[key]` when `body` is an object and that field is a string. */
export function stringField(body: unknown, key: string): string | undefined {
  if (body && typeof body === "object" && key in body) {
    const value = (body as Record<string, unknown>)[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

/** Read `body[key]` when `body` is an object and that field is an array. */
export function arrayField(body: unknown, key: string): unknown[] | undefined {
  if (body && typeof body === "object" && key in body) {
    const value = (body as Record<string, unknown>)[key];
    if (Array.isArray(value)) return value;
  }
  return undefined;
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

/**
 * Join `path` onto `baseUrl`, preserving any subpath prefix on the base. Using
 * `new URL("/v1/x", "https://proxy/hogsend/")` would RESOLVE the absolute path
 * against the origin and silently drop `/hogsend`; we join instead — strip the
 * path's leading slash and ensure the base ends with `/` — so a base like
 * `https://proxy.example.com/hogsend` keeps its prefix. `undefined` query
 * values are dropped.
 */
export function buildUrl(baseUrl: string, path: string, query?: Query): string {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const relPath = path.startsWith("/") ? path.slice(1) : path;
  const url = new URL(relPath, base);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function bodyMessage(status: number, body: unknown): string {
  const error = stringField(body, "error");
  return error ? `${status}: ${error}` : `request failed with status ${status}`;
}

async function request<T>(
  baseUrl: string,
  adminKey: string | undefined,
  method: string,
  path: string,
  opts: { query?: Query; body?: unknown },
): Promise<T> {
  if (!adminKey) {
    throw makeHttpError(
      "no admin key configured — set HOGSEND_ADMIN_KEY / ADMIN_API_KEY or pass --admin-key",
      0,
      undefined,
    );
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${adminKey}`,
  };
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

/** Config for {@link createFetchAdminClient}. */
export interface FetchAdminClientConfig {
  /** Base URL of the target instance (trailing slashes are trimmed). */
  baseUrl: string;
  /** Admin bearer token. When absent, every call rejects with a status-0 error. */
  adminKey: string | undefined;
}

/**
 * Build an {@link AdminClient} over native `fetch` (Node 22). Sends
 * `Authorization: Bearer <adminKey>` on every call, parses JSON, and throws an
 * {@link HttpError} on any non-2xx response (or transport failure).
 */
export function createFetchAdminClient(
  config: FetchAdminClientConfig,
): AdminClient {
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const key = config.adminKey;
  return {
    get: <T>(path: string, query?: Query) =>
      request<T>(baseUrl, key, "GET", path, { query }),
    post: <T>(path: string, body?: unknown) =>
      request<T>(baseUrl, key, "POST", path, { body }),
    patch: <T>(path: string, body?: unknown) =>
      request<T>(baseUrl, key, "PATCH", path, { body }),
  };
}
