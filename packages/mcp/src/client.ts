/**
 * Thin admin HTTP client over native fetch — the ONLY way MCP tools touch a
 * Hogsend instance. Interface-compatible with the CLI's AdminClient
 * (`packages/cli/src/lib/http.ts`) so handlers are trivially fakeable in tests,
 * and so the P2 engine-mounted transport can swap in an in-process
 * `app.request(...)`-backed implementation without touching any tool code.
 */

export interface HttpError extends Error {
  /** HTTP status code, or 0 for a transport-level failure (DNS/connect). */
  status: number;
  /** Parsed JSON body when available, else the raw text, else undefined. */
  body: unknown;
}

export type Query = Record<string, string | number | boolean | undefined>;

export interface AdminClient {
  get<T = unknown>(path: string, query?: Query): Promise<T>;
  post<T = unknown>(path: string, body: unknown): Promise<T>;
  put<T = unknown>(path: string, body: unknown, query?: Query): Promise<T>;
  patch<T = unknown>(path: string, body: unknown): Promise<T>;
  /** The base URL this client points at (for Studio deep links in output). */
  readonly baseUrl: string;
}

export function isHttpError(value: unknown): value is HttpError {
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

async function request<T>(
  baseUrl: string,
  adminKey: string,
  userAgent: string,
  method: string,
  path: string,
  opts: { query?: Query; body?: unknown },
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${adminKey}`,
    "User-Agent": userAgent,
  };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(buildUrl(baseUrl, path, opts.query), {
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

export function createAdminClient(opts: {
  baseUrl: string;
  adminKey: string;
  /** Sent on every request so audit rows attribute to the MCP. */
  userAgent?: string;
}): AdminClient {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const ua = opts.userAgent ?? "hogsend-mcp";
  return {
    baseUrl: base,
    get: <T>(path: string, query?: Query) =>
      request<T>(base, opts.adminKey, ua, "GET", path, { query }),
    post: <T>(path: string, body: unknown) =>
      request<T>(base, opts.adminKey, ua, "POST", path, { body }),
    put: <T>(path: string, body: unknown, query?: Query) =>
      request<T>(base, opts.adminKey, ua, "PUT", path, { body, query }),
    patch: <T>(path: string, body: unknown) =>
      request<T>(base, opts.adminKey, ua, "PATCH", path, { body }),
  };
}
