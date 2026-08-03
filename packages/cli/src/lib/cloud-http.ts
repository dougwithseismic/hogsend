/**
 * The HTTP client for the CONTROL PLANE (`apps/cloud`), as distinct from
 * `http.ts`'s clients for a running engine instance.
 *
 * It is a separate module rather than a fourth constructor in `http.ts` because
 * almost nothing is shared: the cloud answers `{ error, message }` (not
 * `{ error }`), it uses `retry-after`, it takes multipart bodies, and its
 * credential comes from `~/.hogsend/credentials.json` rather than a flag. What
 * IS shared is the shape of a failure, so {@link CloudError} carries the same
 * `status` + `body` a caller can branch on.
 *
 * `fetch` is injected so every flow above this can be tested against a scripted
 * server with no network — the pattern `connect-flow.ts` established.
 *
 * TOKEN HYGIENE INVARIANT: this module never puts the bearer into an error
 * message, a thrown value, or anything returned to a caller.
 */

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/** The cloud's refusal vocabulary, as a typed value rather than a string. */
export class CloudError extends Error {
  /** HTTP status, or 0 for a transport-level failure (DNS/connect/TLS). */
  readonly status: number;
  /** The `error` slug the cloud answered with, when there was one. */
  readonly code: string | undefined;
  /** The parsed body, for callers that need a field the slug does not carry. */
  readonly body: unknown;
  /** Seconds, from `retry-after`, when the cloud asked us to wait. */
  readonly retryAfter: number | undefined;

  constructor(input: {
    message: string;
    status: number;
    code?: string;
    body?: unknown;
    retryAfter?: number;
  }) {
    super(input.message);
    this.name = "CloudError";
    this.status = input.status;
    this.code = input.code;
    this.body = input.body;
    this.retryAfter = input.retryAfter;
  }
}

export function isCloudError(value: unknown): value is CloudError {
  return value instanceof CloudError;
}

export interface CloudClient {
  readonly baseUrl: string;
  /** True when a bearer is bound — `whoami` uses it to fail early and kindly. */
  readonly authenticated: boolean;
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  /** Multipart upload — the publish intake's only content type. */
  postForm<T>(path: string, form: FormData): Promise<T>;
}

export interface CloudClientOptions {
  baseUrl: string;
  /** The `hscli_…` (or `hspub_…`) bearer. Absent → unauthenticated calls. */
  token?: string;
  fetchImpl?: FetchLike;
}

function retryAfterSeconds(headers: Headers): number | undefined {
  const raw = headers.get("retry-after");
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** The cloud's `{ error, message }` envelope, defensively. */
function describe(
  status: number,
  body: unknown,
): { code?: string; message: string } {
  if (body && typeof body === "object") {
    const record = body as { error?: unknown; message?: unknown };
    const code = typeof record.error === "string" ? record.error : undefined;
    const message =
      typeof record.message === "string"
        ? record.message
        : (code ?? `request failed with status ${status}`);
    return code === undefined ? { message } : { code, message };
  }
  return { message: `request failed with status ${status}` };
}

export function createCloudClient(opts: CloudClientOptions): CloudClient {
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  const doFetch = opts.fetchImpl ?? ((url, init) => fetch(url, init));

  async function request<T>(
    method: string,
    path: string,
    init: { json?: unknown; form?: FormData } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    // FormData sets its own multipart boundary — setting content-type here
    // would produce a boundary-less header the server cannot parse.
    if (init.json !== undefined) headers["content-type"] = "application/json";

    const url = `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;

    let response: Response;
    try {
      response = await doFetch(url, {
        method,
        headers,
        body:
          init.form ??
          (init.json === undefined ? undefined : JSON.stringify(init.json)),
      });
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new CloudError({
        message: `cannot reach ${baseUrl} (${detail})`,
        status: 0,
      });
    }

    const text = await response.text();
    let parsed: unknown;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!response.ok) {
      const { code, message } = describe(response.status, parsed);
      const retryAfter = retryAfterSeconds(response.headers);
      throw new CloudError({
        message,
        status: response.status,
        ...(code === undefined ? {} : { code }),
        body: parsed,
        ...(retryAfter === undefined ? {} : { retryAfter }),
      });
    }

    return parsed as T;
  }

  return {
    baseUrl,
    authenticated: Boolean(opts.token),
    get: <T>(path: string) => request<T>("GET", path),
    post: <T>(path: string, body?: unknown) =>
      request<T>("POST", path, body === undefined ? {} : { json: body }),
    postForm: <T>(path: string, form: FormData) =>
      request<T>("POST", path, { form }),
  };
}
