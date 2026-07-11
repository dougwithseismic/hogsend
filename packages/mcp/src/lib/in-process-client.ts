/**
 * In-process {@link AdminClient} for the hosted (Streamable HTTP) transport.
 *
 * Where {@link createFetchAdminClient} reaches a remote instance over `fetch`,
 * this variant dispatches every tool's admin call back through the SAME running
 * app via an injected `fetcher` (Hono's `app.request`). No absolute URL, no
 * network hop — but the SAME code path: it forwards the caller's own
 * `Authorization` (and `Cookie`) header verbatim, so each re-entrant call still
 * traverses `requireAdmin` → validation → rate-limit → audit with the caller's
 * credential, and throws the IDENTICAL {@link HttpError} shape on a non-2xx, so
 * `mapHttpError` (and every tool's result contract) is unchanged.
 *
 * This is the second half of the plan's "one tool implementation, zero parallel
 * auth path": stdio mode = real fetch; hosted mode = this.
 */
import {
  type AdminClient,
  appendQuery,
  handleResponse,
  makeHttpError,
  type Query,
} from "./admin-client.js";

/** The `app.request`-shaped function the in-process client dispatches through. */
export type Fetcher = (path: string, init?: RequestInit) => Promise<Response>;

export interface InProcessAdminClientConfig {
  /** In-process request dispatcher — Hono's `app.request` bound to the app. */
  fetcher: Fetcher;
  /**
   * The inbound request's `Authorization` header value, forwarded verbatim (it
   * already carries the `Bearer ` prefix). Empty string when the caller used the
   * session-cookie path instead — the header is then omitted.
   */
  authorization: string;
  /**
   * The inbound request's `Cookie` header, forwarded verbatim when present, so
   * `requireAdmin`'s Better-Auth session path works for cookie-authed callers
   * (e.g. the Studio). Omitted when absent.
   */
  cookie?: string;
}

/** Build a `/path?query` string — the in-process analogue of `buildUrl`. */
function buildPath(path: string, query?: Query): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return appendQuery(p, query);
}

/**
 * Build an {@link AdminClient} that dispatches in-process via `config.fetcher`,
 * forwarding the caller's credential headers. Mirrors `createFetchAdminClient`'s
 * verb surface and error/JSON handling exactly.
 */
export function createInProcessAdminClient(
  config: InProcessAdminClientConfig,
): AdminClient {
  const { fetcher, authorization, cookie } = config;

  async function request<T>(
    method: string,
    path: string,
    opts: { query?: Query; body?: unknown },
  ): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    // Forward whichever credential the caller presented. `authorization` is
    // verbatim (Bearer …); the empty-string sentinel means "cookie path" — omit
    // the header so it never masks the session cookie.
    if (authorization) headers.Authorization = authorization;
    if (cookie) headers.Cookie = cookie;
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";

    const url = buildPath(path, opts.query);

    let res: Response;
    try {
      res = await fetcher(url, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      throw makeHttpError(`in-process request failed (${msg})`, 0, undefined);
    }

    return handleResponse<T>(res);
  }

  return {
    get: <T>(path: string, query?: Query) => request<T>("GET", path, { query }),
    post: <T>(path: string, body?: unknown) =>
      request<T>("POST", path, { body }),
    patch: <T>(path: string, body?: unknown) =>
      request<T>("PATCH", path, { body }),
  };
}
