import { SubstrateError } from "../types";

/**
 * A minimal typed GraphQL client for Railway's public API.
 *
 * Deliberately dependency-free: plain `fetch` + string documents, exactly like
 * the Go CLI it is ported from (`cli/internal/railway/client.go`). A GraphQL
 * client library would buy nothing here — there are ~15 documents, no
 * fragments, no cache, no subscriptions — and would cost a codegen step plus a
 * schema the vendor changes underneath us.
 *
 * Three things it DOES own, because nothing above the seam may know them:
 *  - the endpoint and the auth header,
 *  - the retry policy, including Railway's notorious intermittent 400s,
 *  - the translation of every vendor failure into `SubstrateError`, with a
 *    `retryable` flag the provisioning pipeline can act on.
 */

export const RAILWAY_API_URL = "https://backboard.railway.com/graphql/v2";

/** Attempts INCLUDING the first, per PRD 04 ("retry w/ backoff, max 5"). */
export const RAILWAY_MAX_ATTEMPTS = 5;

/** First backoff step; each retry doubles it. */
export const RAILWAY_BACKOFF_BASE_MS = 250;

export interface RailwayHttpRequest {
  url: string;
  headers: Record<string, string>;
  /** Already-serialised JSON body. */
  body: string;
}

export interface RailwayHttpResponse {
  status: number;
  body: string;
}

/**
 * The injectable wire. Narrower than `fetch` on purpose: a test supplies an
 * in-memory responder without having to construct a `Response`, and no test
 * can reach the network by forgetting to stub something.
 */
export type RailwayTransport = (
  request: RailwayHttpRequest,
) => Promise<RailwayHttpResponse>;

/** Injectable so tests assert the backoff SEQUENCE without waiting for it. */
export type SleepFn = (ms: number) => Promise<void>;

export interface RailwayClientOptions {
  /** Railway workspace/account token. NEVER logged. */
  token: string;
  /**
   * `bearer` (default) for account/workspace tokens — what the Go CLI uses and
   * what a control plane provisioning many projects needs. `project` switches
   * to `Project-Access-Token`, which Railway requires for project-scoped
   * tokens; those cannot create projects, so they are only useful against a
   * pre-created org project.
   */
  tokenHeader?: "bearer" | "project";
  /** Optional workspace/team to create org projects inside. */
  workspaceId?: string;
  url?: string;
  transport?: RailwayTransport;
  sleep?: SleepFn;
  maxAttempts?: number;
  /** Per-request timeout for the default fetch transport. */
  timeoutMs?: number;
}

/**
 * Deterministic exponential backoff — 250, 500, 1000, 2000ms. NO jitter, by
 * design: the control plane runs one provisioning task per stack (Hatchet
 * serialises them), so there is no thundering herd to spread, and a fixed
 * sequence is assertable in a test.
 */
export function railwayBackoffMs(attempt: number): number {
  return RAILWAY_BACKOFF_BASE_MS * 2 ** (attempt - 1);
}

/**
 * Failures that are the vendor's fault or the moment's, not the request's.
 * Matched on message text because Railway does not return a machine-readable
 * code for them.
 */
const TRANSIENT_MARKER =
  /(problem processing request|internal server error|service unavailable|temporar|timed? out|try again|too many requests|rate limit|econnreset|econnrefused|socket hang up|fetch failed|network|upstream|not ready|unavailable)/i;

/**
 * Should this HTTP failure be retried?
 *
 * 429 and 5xx are obvious. The 400 case is the interesting one and the reason
 * this is a named, tested function: Railway's API intermittently answers a
 * perfectly valid mutation with a 400 carrying no usable GraphQL error
 * (DECISIONS §3 calls this out for `templateDeployV2`). We retry a 400 ONLY
 * when it looks like that — an unparseable body, an empty `errors` array, or a
 * transient marker. A 400 that names a field is a permanent authoring bug, and
 * retrying it would burn the pipeline's attempt budget for nothing.
 */
export function isRetryableHttp(status: number, body: string): boolean {
  if (status === 429 || status >= 500) return true;
  if (status !== 400) return false;
  if (TRANSIENT_MARKER.test(body)) return true;

  try {
    const parsed = JSON.parse(body) as { errors?: { message?: string }[] };
    const errors = parsed.errors ?? [];
    if (errors.length === 0) return true;
    return errors.some((error) => TRANSIENT_MARKER.test(error.message ?? ""));
  } catch {
    // A 400 whose body is not even JSON is Railway's edge, not our document.
    return true;
  }
}

/**
 * A GraphQL-level error (HTTP 200 with `errors`) is PERMANENT unless it names
 * a transient condition — the seam's default is "do not retry", so an
 * implementation has to opt in.
 */
export function isRetryableGraphQLMessage(message: string): boolean {
  return TRANSIENT_MARKER.test(message);
}

const defaultSleep: SleepFn = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

function defaultTransport(timeoutMs: number): RailwayTransport {
  return async ({ url, headers, body }) => {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: response.status, body: await response.text() };
  };
}

export class RailwayClient {
  private readonly token: string;
  private readonly tokenHeader: "bearer" | "project";
  private readonly url: string;
  private readonly transport: RailwayTransport;
  private readonly sleep: SleepFn;
  private readonly maxAttempts: number;
  readonly workspaceId: string | undefined;

  constructor(options: RailwayClientOptions) {
    this.token = options.token;
    this.tokenHeader = options.tokenHeader ?? "bearer";
    this.workspaceId = options.workspaceId;
    this.url = options.url ?? RAILWAY_API_URL;
    this.transport =
      options.transport ?? defaultTransport(options.timeoutMs ?? 30_000);
    this.sleep = options.sleep ?? defaultSleep;
    this.maxAttempts = options.maxAttempts ?? RAILWAY_MAX_ATTEMPTS;
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      ...(this.tokenHeader === "project"
        ? { "Project-Access-Token": this.token }
        : { Authorization: `Bearer ${this.token}` }),
    };
  }

  /**
   * Execute one document. Returns `data` typed as `T`; throws
   * `SubstrateError` — the ONLY error type allowed to cross the seam.
   */
  async request<T = Record<string, unknown>>(
    document: string,
    variables?: Record<string, unknown>,
  ): Promise<T> {
    const body = JSON.stringify({ query: document, variables });
    let lastError: SubstrateError | undefined;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const outcome = await this.attempt<T>(body);
      if (outcome.ok) return outcome.data;

      lastError = outcome.error;
      if (!outcome.error.retryable) throw outcome.error;
      if (attempt < this.maxAttempts) {
        await this.sleep(railwayBackoffMs(attempt));
      }
    }

    // Exhausted: still RETRYABLE, so the pipeline parks the step for a later
    // attempt rather than declaring the stack permanently broken.
    throw new SubstrateError(
      `Railway API did not succeed after ${this.maxAttempts} attempts: ${lastError?.message ?? "unknown error"}`,
      { retryable: true, cause: lastError },
    );
  }

  private async attempt<T>(
    body: string,
  ): Promise<{ ok: true; data: T } | { ok: false; error: SubstrateError }> {
    let response: RailwayHttpResponse;
    try {
      response = await this.transport({
        url: this.url,
        headers: this.headers(),
        body,
      });
    } catch (cause) {
      // A thrown transport is a network fault (DNS, reset, timeout): always
      // worth another attempt.
      return {
        ok: false,
        error: new SubstrateError(
          `Railway API request failed: ${errorMessage(cause)}`,
          { retryable: true, cause },
        ),
      };
    }

    if (response.status !== 200) {
      return {
        ok: false,
        error: new SubstrateError(
          `Railway API error (HTTP ${response.status}): ${truncate(response.body)}`,
          { retryable: isRetryableHttp(response.status, response.body) },
        ),
      };
    }

    let payload: { data?: T; errors?: { message?: string }[] };
    try {
      payload = JSON.parse(response.body) as typeof payload;
    } catch (cause) {
      return {
        ok: false,
        error: new SubstrateError(
          `Railway API returned a non-JSON 200: ${truncate(response.body)}`,
          { retryable: true, cause },
        ),
      };
    }

    const message = payload.errors?.[0]?.message;
    if (message) {
      return {
        ok: false,
        error: new SubstrateError(`Railway GraphQL error: ${message}`, {
          retryable: isRetryableGraphQLMessage(message),
        }),
      };
    }

    return { ok: true, data: (payload.data ?? {}) as T };
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Response bodies land in `last_error` on the stack row; keep them bounded. */
function truncate(body: string, max = 300): string {
  return body.length > max ? `${body.slice(0, max)}…` : body;
}
