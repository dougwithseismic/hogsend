import type { Logger } from "./logger.js";

/**
 * Idempotent provisioner for the "PostHog → Hogsend" webhook destination —
 * the PostHog-side half of the event loop `hogsend connect posthog` sets up
 * (a hog function, `type: "destination"`, template `template-webhook`,
 * POSTing identified events to `${apiPublicUrl}/v1/webhooks/posthog`).
 *
 * Pure HTTP (global `fetch`) — no DB, no Hatchet. Adoption matches by the
 * webhook URL's pathname (endsWith /v1/webhooks/posthog), not by name, so
 * renamed functions, host migrations, and legacy Go-CLI creations are
 * adopted rather than duplicated. Reconciliation enforces only what we
 * manage (url/method/body, our two headers, the $is_identified filter,
 * enabled) and preserves operator customization (extra headers, extra
 * filter properties, debug, name/description).
 *
 * The webhook secret deliberately rides in a NON-secret header input
 * (matching the template): secret inputs are redacted on GET, which would
 * break adopt-diffing and secret-rotation detection. Anyone with PostHog
 * project access can read it — same trust domain, acceptable.
 */

export interface ProvisionPostHogLoopOptions {
  /**
   * Private (app) API host, e.g. https://eu.posthog.com — ALREADY derived
   * (derivePrivateHost / POSTHOG_PRIVATE_HOST). Never the ingestion host.
   */
  privateHost: string;
  /** Bearer credential: OAuth access token (pha_) or personal key (phx_). */
  accessToken: string;
  /** Skip /api/projects/@current/ discovery when known. */
  projectId?: string | number;
  /**
   * Public base URL of THIS engine (env API_PUBLIC_URL), no trailing slash
   * needed.
   */
  apiPublicUrl: string;
  /**
   * Shared secret the consumer's posthog webhook source matches
   * (env POSTHOG_WEBHOOK_SECRET). `undefined`/"" ⇒ REFUSE: match-auth
   * webhook sources are OPEN when their secret env is unset, so
   * provisioning without one would point PostHog at an unauthenticated
   * ingest route.
   */
  webhookSecret: string | undefined;
  logger: Logger;
  /** Display name for a NEWLY created function. Default: MANAGED_NAME. */
  name?: string;
}

export interface ProvisionPostHogLoopResult {
  action: "created" | "updated" | "unchanged";
  /** Hog function UUID. */
  functionId: string;
  /** Resolved numeric project id (stringified). */
  projectId: string;
  /** The URL the destination POSTs to: `${apiPublicUrl}/v1/webhooks/posthog`. */
  webhookUrl: string;
  /** Best-effort deep link (pattern unverified — cosmetic, confirm in e2e). */
  dashboardUrl: string;
}

export type ProvisionPostHogLoopErrorCode =
  | "missing-webhook-secret" // refused before any network call
  | "unauthorized" // HTTP 401 — bad/expired token
  | "missing-scope" // HTTP 403 — token lacks a required scope
  | "unsupported-instance" // 404 on the hog_functions collection
  | "project-discovery-failed" // @current failed and no projectId given
  | "api-error"; // any other non-2xx / network failure

export class ProvisionPostHogLoopError extends Error {
  readonly code: ProvisionPostHogLoopErrorCode;
  /** Operator-facing remediation — the CLI/admin route prints it VERBATIM. */
  readonly remediation: string;
  readonly status?: number;

  constructor(opts: {
    code: ProvisionPostHogLoopErrorCode;
    message: string;
    remediation: string;
    status?: number;
  }) {
    super(opts.message);
    this.name = "ProvisionPostHogLoopError";
    this.code = opts.code;
    this.remediation = opts.remediation;
    this.status = opts.status;
  }
}

/** Path marker that identifies the Hogsend loop regardless of host. */
const HOGSEND_LOOP_PATH = "/v1/webhooks/posthog";
const MANAGED_NAME = "Hogsend ingest — identified events";
const MANAGED_DESCRIPTION =
  "Forwards identified PostHog events to Hogsend. Managed by " +
  "`hogsend connect posthog` — safe to re-run; extra headers and " +
  "filters you add here are preserved.";
const IS_IDENTIFIED_FILTER = {
  key: "$is_identified",
  type: "event",
  value: ["true"],
  operator: "exact",
} as const;
const CANONICAL_BODY = { event: "{event}", person: "{person}" } as const;
const FETCH_TIMEOUT_MS = 15_000;
/** Detail-GET budget while hunting for an adoptable function. */
const MAX_ADOPT_PROBES = 25;
/** Pagination guard — a misbehaving `next` must never loop forever. */
const MAX_LIST_PAGES = 20;

/**
 * Canonical `template-webhook` hog source — PATCHed onto legacy Go-CLI
 * functions (whose custom hog reads `inputs.payload`) so the five-key
 * canonical inputs drive the request after normalization.
 */
const TEMPLATE_WEBHOOK_HOG = `let payload := {
  'headers': inputs.headers,
  'body': inputs.body,
  'method': inputs.method
}

if (inputs.debug) {
  print('Request', inputs.url, payload)
}

let res := fetch(inputs.url, payload);

if (res.status >= 400) {
  throw Error(f'Webhook failed with status {res.status}: {res.body}');
}

if (inputs.debug) {
  print('Response', res.status, res.body);
}`;

/** Canonical `template-webhook` inputs_schema (five fields, verbatim). */
const TEMPLATE_WEBHOOK_INPUTS_SCHEMA = [
  {
    type: "string",
    key: "url",
    label: "Webhook URL",
    required: true,
    secret: false,
    hidden: false,
    description: "Endpoint URL to send event data to.",
  },
  {
    type: "choice",
    key: "method",
    label: "Method",
    choices: [
      { label: "POST", value: "POST" },
      { label: "PUT", value: "PUT" },
      { label: "PATCH", value: "PATCH" },
      { label: "GET", value: "GET" },
      { label: "DELETE", value: "DELETE" },
    ],
    required: false,
    default: "POST",
    secret: false,
    hidden: false,
    description: "HTTP method to use for the request.",
  },
  {
    type: "json",
    key: "body",
    label: "JSON Body",
    required: false,
    default: { event: "{event}", person: "{person}" },
    secret: false,
    hidden: false,
    description: "JSON payload to send in the request body.",
  },
  {
    type: "dictionary",
    key: "headers",
    label: "Headers",
    required: false,
    default: { "Content-Type": "application/json" },
    secret: false,
    hidden: false,
    description: "HTTP headers to send in the request.",
  },
  {
    type: "boolean",
    key: "debug",
    label: "Log responses",
    required: false,
    default: false,
    secret: false,
    hidden: false,
    description: "Logs the response of http calls for debugging.",
  },
];

const MISSING_SECRET_REMEDIATION =
  "Without POSTHOG_WEBHOOK_SECRET the POST /v1/webhooks/posthog route " +
  "accepts UNAUTHENTICATED traffic (match-auth webhook sources are open " +
  "when their secret is unset). Generate one (e.g. openssl rand -hex 32), " +
  "set POSTHOG_WEBHOOK_SECRET on both the API and worker services, " +
  "redeploy, then run `hogsend connect posthog --provision-only`.";
const UNAUTHORIZED_REMEDIATION =
  "The PostHog credential was rejected. Re-run hogsend connect posthog " +
  "to obtain a fresh token, or check POSTHOG_PERSONAL_API_KEY.";
const MISSING_SCOPE_REMEDIATION =
  "The PostHog credential lacks a required scope. The connect flow " +
  "needs: hog_function:write, project:read (plus person:read, " +
  "person:write for person access). For a personal API key, edit its " +
  "scopes in PostHog → Settings → Personal API keys.";
const UNSUPPORTED_INSTANCE_REMEDIATION =
  "This PostHog instance does not expose the hog functions API. Set the " +
  "webhook destination up manually (docs: " +
  "/docs/getting-started/posthog-setup) or upgrade PostHog.";
const PROJECT_DISCOVERY_REMEDIATION =
  "Could not discover the PostHog project id. Pass projectId explicitly " +
  "or set POSTHOG_PROJECT_ID.";
const API_ERROR_REMEDIATION =
  "PostHog returned an unexpected error. Check the status and detail " +
  "above, then re-run `hogsend connect posthog --provision-only`.";

/** Internal — only the detail fields the provisioner reads. */
interface HogFunctionDetail {
  id: string;
  enabled: boolean;
  inputs: Record<string, { value?: unknown } | null> | null;
  filters: {
    source?: string;
    properties?: unknown[];
    bytecode?: unknown;
    [k: string]: unknown;
  } | null;
  inputs_schema?: Array<{ key: string }>;
  template?: { id?: string } | null;
  name: string;
}

interface DesiredLoop {
  webhookUrl: string;
  webhookSecret: string;
}

/**
 * Idempotently create-or-adopt the "PostHog → Hogsend" hog-function
 * destination. Safe to re-run: an already-compliant function is left
 * untouched ("unchanged"), a drifted one is reconciled ("updated"), and
 * only when no function POSTs to this engine's `/v1/webhooks/posthog`
 * path is a new one created ("created").
 */
export async function provisionPostHogLoop(
  opts: ProvisionPostHogLoopOptions,
): Promise<ProvisionPostHogLoopResult> {
  const { privateHost, accessToken, apiPublicUrl, webhookSecret, logger } =
    opts;

  if (!webhookSecret) {
    throw new ProvisionPostHogLoopError({
      code: "missing-webhook-secret",
      message: "POSTHOG_WEBHOOK_SECRET is not set — refusing to provision.",
      remediation: MISSING_SECRET_REMEDIATION,
    });
  }

  const webhookUrl = joinUrl(apiPublicUrl, HOGSEND_LOOP_PATH);
  const hostname = tryParseUrl(webhookUrl)?.hostname;
  if (hostname === "localhost" || hostname === "127.0.0.1") {
    logger.warn(
      "API_PUBLIC_URL is a loopback host — PostHog Cloud cannot reach it",
      { url: webhookUrl },
    );
  }

  const projectId =
    opts.projectId !== undefined
      ? String(opts.projectId)
      : await discoverProjectId({ privateHost, accessToken });

  const basePath = `/api/environments/${projectId}/hog_functions/`;
  const desired: DesiredLoop = { webhookUrl, webhookSecret };

  const found = await findLoopFunction({ privateHost, accessToken, basePath });

  let action: ProvisionPostHogLoopResult["action"];
  let functionId: string;

  if (found && isCompliant(found, desired)) {
    action = "unchanged";
    functionId = found.id;
  } else if (found) {
    await phFetch({
      privateHost,
      accessToken,
      path: `${basePath}${found.id}/`,
      method: "PATCH",
      body: buildUpdatePayload(found, desired),
    });
    action = "updated";
    functionId = found.id;
  } else {
    const created = await phFetch({
      privateHost,
      accessToken,
      path: basePath,
      method: "POST",
      body: buildCreatePayload(desired, opts.name),
      notFoundMeansUnsupported: true,
    });
    const id = isRecord(created) ? created.id : undefined;
    if (typeof id !== "string" && typeof id !== "number") {
      throw new ProvisionPostHogLoopError({
        code: "api-error",
        message: "PostHog created the hog function but returned no id.",
        remediation: API_ERROR_REMEDIATION,
      });
    }
    action = "created";
    functionId = String(id);
  }

  logger.info("Provisioned PostHog → Hogsend loop", {
    action,
    functionId,
    projectId,
    url: webhookUrl,
  });

  return {
    action,
    functionId,
    projectId,
    webhookUrl,
    dashboardUrl:
      `${privateHost.replace(/\/+$/, "")}/project/${projectId}` +
      `/pipeline/destinations/hog-${functionId}/configuration`,
  };
}

/**
 * One-shot `@current` discovery, used only when `opts.projectId` is not
 * given. Deliberately uncached and NOT shared with plugin-posthog's
 * `resolveProjectId` — different process/cadence; provisioning is a
 * one-shot admin action that tolerates a stray re-discovery.
 */
async function discoverProjectId(opts: {
  privateHost: string;
  accessToken: string;
}): Promise<string> {
  let body: unknown;
  try {
    body = await phFetch({
      privateHost: opts.privateHost,
      accessToken: opts.accessToken,
      path: "/api/projects/@current/",
    });
  } catch (err) {
    if (
      err instanceof ProvisionPostHogLoopError &&
      (err.code === "unauthorized" || err.code === "missing-scope")
    ) {
      throw err;
    }
    throw new ProvisionPostHogLoopError({
      code: "project-discovery-failed",
      message: `PostHog project discovery failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
      remediation: PROJECT_DISCOVERY_REMEDIATION,
    });
  }
  const id = isRecord(body) ? body.id : undefined;
  if (typeof id !== "number" && typeof id !== "string") {
    throw new ProvisionPostHogLoopError({
      code: "project-discovery-failed",
      message: "PostHog /api/projects/@current/ returned no project id.",
      remediation: PROJECT_DISCOVERY_REMEDIATION,
    });
  }
  return String(id);
}

/** Bearer + JSON fetch with the documented error mapping. */
async function phFetch(opts: {
  privateHost: string;
  accessToken: string;
  /** e.g. `/api/environments/${id}/hog_functions/` */
  path: string;
  method?: string;
  body?: unknown;
  /** 404 here means "instance has no hog functions" (self-hosted/old). */
  notFoundMeansUnsupported?: boolean;
}): Promise<unknown> {
  const url = joinUrl(opts.privateHost, opts.path);
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? "GET",
      headers: {
        Authorization: `Bearer ${opts.accessToken}`,
        ...(opts.body !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new ProvisionPostHogLoopError({
      code: "api-error",
      message: `PostHog request failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
      remediation: API_ERROR_REMEDIATION,
    });
  }

  if (!res.ok) {
    const detail = await readErrorDetail(res);
    if (res.status === 401) {
      throw new ProvisionPostHogLoopError({
        code: "unauthorized",
        message: `PostHog rejected the credential (401): ${detail}`,
        remediation: UNAUTHORIZED_REMEDIATION,
        status: 401,
      });
    }
    if (res.status === 403) {
      throw new ProvisionPostHogLoopError({
        code: "missing-scope",
        message: `PostHog denied the request (403): ${detail}`,
        remediation: MISSING_SCOPE_REMEDIATION,
        status: 403,
      });
    }
    if (res.status === 404 && opts.notFoundMeansUnsupported) {
      throw new ProvisionPostHogLoopError({
        code: "unsupported-instance",
        message: `PostHog has no hog functions API (404): ${detail}`,
        remediation: UNSUPPORTED_INSTANCE_REMEDIATION,
        status: 404,
      });
    }
    throw new ProvisionPostHogLoopError({
      code: "api-error",
      message: `PostHog request failed (${res.status}): ${detail}`,
      remediation: API_ERROR_REMEDIATION,
      status: res.status,
    });
  }

  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

/** PostHog error bodies are `{ type, code, detail, attr }` — prefer detail. */
async function readErrorDetail(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  let detail = text;
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed) && typeof parsed.detail === "string") {
      detail = parsed.detail;
    }
  } catch {
    // non-JSON body — keep the raw text
  }
  return detail.length > 200 ? `${detail.slice(0, 200)}…` : detail;
}

/**
 * Paginate the destination list, detail-GET candidates (hogsend-named
 * first), and return the first function whose `inputs.url` parses and
 * whose pathname ends with HOGSEND_LOOP_PATH. Matching by URL (not name)
 * is the stable marker: it survives renames AND host migrations, and the
 * legacy Go-CLI functions are adopted by the same rule.
 */
async function findLoopFunction(opts: {
  privateHost: string;
  accessToken: string;
  basePath: string;
}): Promise<HogFunctionDetail | undefined> {
  const candidates: Array<{ id: string; name: string }> = [];
  let path: string | undefined = `${opts.basePath}?type=destination&limit=100`;

  for (let page = 0; path && page < MAX_LIST_PAGES; page++) {
    const listing = await phFetch({
      privateHost: opts.privateHost,
      accessToken: opts.accessToken,
      path,
      notFoundMeansUnsupported: true,
    });
    const results =
      isRecord(listing) && Array.isArray(listing.results)
        ? listing.results
        : [];
    for (const item of results) {
      if (!isRecord(item) || item.id === undefined || item.id === null) {
        continue;
      }
      // ?type=destination is server-side; keep a client-side check in case
      // a PostHog release drops the filter.
      if (typeof item.type === "string" && item.type !== "destination") {
        continue;
      }
      candidates.push({
        id: String(item.id),
        name: typeof item.name === "string" ? item.name : "",
      });
    }
    const next = isRecord(listing) ? listing.next : undefined;
    path = typeof next === "string" && next ? pathAndSearch(next) : undefined;
  }

  // List items carry no `inputs`, so matching needs a detail GET per
  // candidate — probe likely matches (hogsend-named) first, on a budget.
  const named = candidates.filter((c) =>
    c.name.toLowerCase().includes("hogsend"),
  );
  const rest = candidates.filter(
    (c) => !c.name.toLowerCase().includes("hogsend"),
  );
  const ordered = [...named, ...rest].slice(0, MAX_ADOPT_PROBES);

  for (const candidate of ordered) {
    const detail = await phFetch({
      privateHost: opts.privateHost,
      accessToken: opts.accessToken,
      path: `${opts.basePath}${candidate.id}/`,
    });
    if (!isRecord(detail)) continue;
    const fn = detail as unknown as HogFunctionDetail;
    const urlValue = inputValue(fn.inputs, "url");
    if (typeof urlValue !== "string") continue;
    const parsed = tryParseUrl(urlValue);
    if (parsed?.pathname.endsWith(HOGSEND_LOOP_PATH)) return fn;
  }
  return undefined;
}

/** true ⇒ no PATCH needed. */
function isCompliant(fn: HogFunctionDetail, desired: DesiredLoop): boolean {
  if (fn.enabled !== true) return false;
  if (inputValue(fn.inputs, "url") !== desired.webhookUrl) return false;
  if (inputValue(fn.inputs, "method") !== "POST") return false;
  if (!deepEquals(inputValue(fn.inputs, "body"), CANONICAL_BODY)) return false;
  const headers = inputValue(fn.inputs, "headers");
  if (!isRecord(headers)) return false;
  if (headers["Content-Type"] !== "application/json") return false;
  if (headers["x-posthog-webhook-secret"] !== desired.webhookSecret) {
    return false;
  }
  if (!hasIdentifiedFilter(fn.filters?.properties)) return false;
  return hasCanonicalSchema(fn.inputs_schema);
}

/** Canonical five-key schema, and NO legacy Go-CLI `payload` key. */
function hasCanonicalSchema(
  schema: HogFunctionDetail["inputs_schema"],
): boolean {
  const keys = new Set((schema ?? []).map((field) => field.key));
  if (keys.has("payload")) return false;
  return ["url", "method", "body", "headers", "debug"].every((key) =>
    keys.has(key),
  );
}

function hasIdentifiedFilter(properties: unknown[] | undefined): boolean {
  return (properties ?? []).some(isCompliantIdentifiedEntry);
}

function isCompliantIdentifiedEntry(entry: unknown): boolean {
  if (!isRecord(entry)) return false;
  if (entry.key !== "$is_identified" || entry.operator !== "exact") {
    return false;
  }
  // Accept ["true"], [true], "true", true — the UI writes ["true"], other
  // writers vary; representation differences must not churn a PATCH.
  const value =
    Array.isArray(entry.value) && entry.value.length === 1
      ? entry.value[0]
      : entry.value;
  return value === true || value === "true";
}

function buildCreatePayload(
  desired: DesiredLoop,
  name: string | undefined,
): Record<string, unknown> {
  return {
    type: "destination",
    name: name ?? MANAGED_NAME,
    description: MANAGED_DESCRIPTION,
    template_id: "template-webhook",
    enabled: true,
    inputs: {
      url: { value: desired.webhookUrl },
      method: { value: "POST" },
      body: { value: { ...CANONICAL_BODY } },
      headers: {
        value: {
          "Content-Type": "application/json",
          "x-posthog-webhook-secret": desired.webhookSecret,
        },
      },
      debug: { value: false },
    },
    filters: {
      source: "events",
      properties: [IS_IDENTIFIED_FILTER],
    },
  };
}

/**
 * Reconciled PATCH body: enforce what we manage, preserve the rest.
 * `enabled: true` always — connect is an explicit operator action, so
 * re-enabling a paused loop is the expected outcome. PostHog replaces
 * `inputs` WHOLESALE on PATCH (verified), so all five keys are always
 * sent. `name`/`description` are never touched on adopt — the operator
 * may have renamed deliberately.
 */
function buildUpdatePayload(
  fn: HogFunctionDetail,
  desired: DesiredLoop,
): Record<string, unknown> {
  const currentHeaders = inputValue(fn.inputs, "headers");
  const extraHeaders = isRecord(currentHeaders) ? currentHeaders : {};
  const currentDebug = inputValue(fn.inputs, "debug");

  const filters: Record<string, unknown> = isRecord(fn.filters)
    ? { ...fn.filters }
    : {};
  // Never send stale bytecode back — the server recompiles (verified).
  delete filters.bytecode;
  filters.source = "events";
  const properties = Array.isArray(filters.properties)
    ? [...filters.properties]
    : [];
  if (!properties.some(isCompliantIdentifiedEntry)) {
    properties.push(IS_IDENTIFIED_FILTER);
  }
  filters.properties = properties;

  const payload: Record<string, unknown> = {
    enabled: true,
    inputs: {
      url: { value: desired.webhookUrl },
      method: { value: "POST" },
      body: { value: { ...CANONICAL_BODY } },
      // Operator-added headers survive; ours win on collision.
      headers: {
        value: {
          ...extraHeaders,
          "Content-Type": "application/json",
          "x-posthog-webhook-secret": desired.webhookSecret,
        },
      },
      debug: {
        value: typeof currentDebug === "boolean" ? currentDebug : false,
      },
    },
    filters,
  };

  // Legacy Go-CLI normalization: its functions carry a custom hog source
  // reading `inputs.payload` — rewrite both hog and inputs_schema to the
  // canonical template shape so the five canonical inputs take effect.
  if (!hasCanonicalSchema(fn.inputs_schema)) {
    payload.hog = TEMPLATE_WEBHOOK_HOG;
    payload.inputs_schema = TEMPLATE_WEBHOOK_INPUTS_SCHEMA;
  }

  return payload;
}

function inputValue(inputs: HogFunctionDetail["inputs"], key: string): unknown {
  const entry = inputs?.[key];
  return isRecord(entry) ? entry.value : undefined;
}

/**
 * `base.replace(/\/+$/, "") + path` on purpose — `new URL(path, base)`
 * drops path prefixes on the base, breaking path-prefixed deployments.
 */
function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, "") + path;
}

function tryParseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** DRF `next` is absolute — re-issue through phFetch as path+search. */
function pathAndSearch(absolute: string): string {
  const parsed = tryParseUrl(absolute);
  return parsed ? `${parsed.pathname}${parsed.search}` : absolute;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEquals(v, b[i]));
  }
  if (isRecord(a) && isRecord(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    return (
      aKeys.length === bKeys.length &&
      aKeys.every((k) => deepEquals(a[k], b[k]))
    );
  }
  return false;
}
