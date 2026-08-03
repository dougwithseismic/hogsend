/**
 * Live credential probes — "does this key actually work?" — one per provider.
 *
 * The laws:
 *  - **Fail CLOSED.** Anything that is not a clear success is `valid: false`:
 *    a refusal, an unexpected status, a timeout, a DNS failure. The caller
 *    stores NOTHING on a false, so a control plane never holds a credential it
 *    could not prove.
 *  - **Fetch is INJECTED.** Every test in this app passes a fake; nothing here
 *    reaches a vendor from CI, and no real credential is needed to be green.
 *  - **Nothing is logged.** These functions see plaintext secrets and never
 *    print, throw or return them — `detail` is a fixed vocabulary of slugs.
 *  - **Bounded.** A validator runs behind a 5s timeout, because it sits inside
 *    a form submit and a hung vendor must not become a hung request.
 */

/** Short enough that a paste-your-key form never feels hung. */
export const KEY_VALIDATION_TIMEOUT_MS = 5_000;

export interface ProviderKeyValidation {
  valid: boolean;
  /**
   * A stable slug, never a vendor's prose: `ok`, `shape_only`, `unauthorized`,
   * `not_found`, `unreachable`, `http_<status>`, `missing_field:<name>`,
   * `malformed_key`, `unsupported_provider`.
   */
  detail: string;
  /**
   * Sending domains the provider reports as VERIFIED. Present only for
   * providers that expose the list (Resend today); the sender-identity gate
   * enforces membership when it is present.
   */
  verifiedDomains?: string[];
}

export type FetchImpl = typeof fetch;

export interface ValidateProviderKeyInput {
  provider: string;
  payload: Record<string, string>;
  fetchImpl?: FetchImpl | undefined;
  timeoutMs?: number | undefined;
}

interface ProbeInput {
  payload: Record<string, string>;
  fetchImpl: FetchImpl;
  timeoutMs: number;
}

type Validator = (input: ProbeInput) => Promise<ProviderKeyValidation>;

function pick(
  payload: Record<string, string>,
  ...names: string[]
): string | undefined {
  for (const name of names) {
    const value = payload[name];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

/** The status → slug rule every probe shares. */
function statusDetail(status: number): string {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "not_found";
  return `http_${status}`;
}

type ProbeOutcome =
  | { kind: "ok"; response: Response }
  | { kind: "failed"; detail: string };

/**
 * One bounded request. A thrown fetch — DNS, TLS, refused connection, abort —
 * is `unreachable` rather than an exception, because "we could not check" and
 * "the key is bad" have the SAME consequence here (store nothing) and a caller
 * should not have to catch to get it right.
 */
async function probe(
  fetchImpl: FetchImpl,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<ProbeOutcome> {
  try {
    const response = await fetchImpl(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok)
      return { kind: "failed", detail: statusDetail(response.status) };
    return { kind: "ok", response };
  } catch {
    return { kind: "failed", detail: "unreachable" };
  }
}

/** Body JSON, or undefined — a malformed body is never a crash. */
async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/**
 * Resend: the domains list. It doubles as the sender-identity source of truth,
 * which is why it is the probe rather than a cheaper ping.
 */
const validateResend: Validator = async ({ payload, fetchImpl, timeoutMs }) => {
  const apiKey = pick(payload, "apiKey", "api_key", "key");
  if (!apiKey) return { valid: false, detail: "missing_field:apiKey" };

  const outcome = await probe(
    fetchImpl,
    "https://api.resend.com/domains",
    { method: "GET", headers: { authorization: `Bearer ${apiKey}` } },
    timeoutMs,
  );
  if (outcome.kind === "failed") {
    return { valid: false, detail: outcome.detail };
  }

  const body = (await readJson(outcome.response)) as
    | { data?: Array<{ name?: unknown; status?: unknown }> }
    | undefined;
  const verifiedDomains = (body?.data ?? [])
    .filter((entry) => entry?.status === "verified")
    .map((entry) => String(entry.name ?? "").toLowerCase())
    .filter((name) => name.length > 0);

  return { valid: true, detail: "ok", verifiedDomains };
};

/** Postmark: the server the token belongs to. */
const validatePostmark: Validator = async ({
  payload,
  fetchImpl,
  timeoutMs,
}) => {
  const token = pick(payload, "serverToken", "apiKey", "token");
  if (!token) return { valid: false, detail: "missing_field:serverToken" };

  const outcome = await probe(
    fetchImpl,
    "https://api.postmarkapp.com/server",
    {
      method: "GET",
      headers: { accept: "application/json", "x-postmark-server-token": token },
    },
    timeoutMs,
  );
  return outcome.kind === "ok"
    ? { valid: true, detail: "ok" }
    : { valid: false, detail: outcome.detail };
};

/** A `phc_` project key, by shape. See the note on `validatePosthog`. */
const POSTHOG_PROJECT_KEY_RE = /^phc_[A-Za-z0-9_-]{16,}$/;

const DEFAULT_POSTHOG_HOST = "https://us.posthog.com";

/**
 * PostHog, and the one deliberate asymmetry in this file.
 *
 * The `phc_` PROJECT key is write-only by PostHog's design: there is no read
 * endpoint that authenticates with it, and every capture-shaped probe PERSISTS
 * an event into the tenant's project. Writing junk into a customer's analytics
 * to prove a key is not a trade a control plane should make, so the project key
 * is validated by SHAPE only and the result says `shape_only` rather than
 * claiming `ok`.
 *
 * The PERSONAL key (`POSTHOG_PERSONAL_API_KEY`) IS live-probed, against
 * `/api/projects/` — a read, no side effects — and it is the key that actually
 * matters: without it the engine's person-property reads soft-fail.
 */
const validatePosthog: Validator = async ({
  payload,
  fetchImpl,
  timeoutMs,
}) => {
  const projectKey = pick(payload, "apiKey", "projectApiKey");
  const personalKey = pick(payload, "personalApiKey");
  if (!projectKey && !personalKey) {
    return { valid: false, detail: "missing_field:apiKey" };
  }
  if (projectKey && !POSTHOG_PROJECT_KEY_RE.test(projectKey)) {
    return { valid: false, detail: "malformed_key" };
  }
  if (!personalKey) return { valid: true, detail: "shape_only" };

  const host = (pick(payload, "host") ?? DEFAULT_POSTHOG_HOST).replace(
    /\/+$/,
    "",
  );
  const outcome = await probe(
    fetchImpl,
    `${host}/api/projects/`,
    {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${personalKey}`,
      },
    },
    timeoutMs,
  );
  return outcome.kind === "ok"
    ? { valid: true, detail: "ok" }
    : { valid: false, detail: outcome.detail };
};

/** Twilio: fetch the account the SID names, with the token as basic auth. */
const validateTwilio: Validator = async ({ payload, fetchImpl, timeoutMs }) => {
  const accountSid = pick(payload, "accountSid", "sid");
  const authToken = pick(payload, "authToken", "token");
  if (!accountSid) return { valid: false, detail: "missing_field:accountSid" };
  if (!authToken) return { valid: false, detail: "missing_field:authToken" };

  const basic = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
  const outcome = await probe(
    fetchImpl,
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}.json`,
    { method: "GET", headers: { authorization: `Basic ${basic}` } },
    timeoutMs,
  );
  return outcome.kind === "ok"
    ? { valid: true, detail: "ok" }
    : { valid: false, detail: outcome.detail };
};

/** Every provider whose credentials the control plane can prove. */
export const KEY_VALIDATORS: Record<string, Validator> = {
  resend: validateResend,
  postmark: validatePostmark,
  posthog: validatePosthog,
  twilio: validateTwilio,
};

/** Providers a tenant may configure through this flow. */
export const VALIDATABLE_PROVIDERS: readonly string[] =
  Object.keys(KEY_VALIDATORS).sort();

/**
 * Validate one submitted credential. A provider with no validator is REFUSED
 * rather than waved through — an unprovable key would be stored as "verified"
 * on nothing but the tenant's word.
 */
export async function validateProviderKey(
  input: ValidateProviderKeyInput,
): Promise<ProviderKeyValidation> {
  const validator = KEY_VALIDATORS[input.provider];
  if (!validator) return { valid: false, detail: "unsupported_provider" };

  return validator({
    payload: input.payload,
    fetchImpl: input.fetchImpl ?? fetch,
    timeoutMs: input.timeoutMs ?? KEY_VALIDATION_TIMEOUT_MS,
  });
}
