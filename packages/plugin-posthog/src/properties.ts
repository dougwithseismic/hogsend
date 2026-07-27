import type { PersonPropertiesCache, PersonPropertiesConfig } from "./types.js";

const CACHE_PREFIX = "posthog:person:";
const DEFAULT_TTL = 300;
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Derive the private (app) API host from a capture/ingestion host by
 * stripping PostHog Cloud's `.i.` ingestion label:
 *
 *   https://eu.i.posthog.com → https://eu.posthog.com
 *   https://us.i.posthog.com → https://us.posthog.com
 *
 * Self-hosted instances serve both planes on one host, so anything that
 * doesn't match the Cloud ingestion pattern passes through unchanged.
 */
export function derivePrivateHost(host: string): string {
  return host.replace(/^(https?:\/\/[a-z0-9-]+)\.i\.(posthog\.com)/i, "$1.$2");
}

/**
 * The inverse of {@link derivePrivateHost}: map a PostHog Cloud APP host to its
 * capture/ingestion host by inserting the `.i.` label:
 *
 *   https://eu.posthog.com → https://eu.i.posthog.com
 *   https://us.posthog.com → https://us.i.posthog.com
 *
 * Used when the ONLY stored host is the private one (the `hogsend connect
 * posthog` derived credential) and the engine needs somewhere to capture to.
 * Self-hosted instances serve both planes on one host, so anything that
 * doesn't match the Cloud pattern passes through unchanged — including hosts
 * that already carry the `.i.` label (the single dot-free label the pattern
 * requires can't span it).
 */
export function deriveIngestHost(privateHost: string): string {
  return privateHost.replace(
    /^(https?:\/\/[a-z0-9-]+)\.(posthog\.com)/i,
    "$1.i.$2",
  );
}

/**
 * Resolve the project id for environment-scoped private endpoints via
 * `GET /api/projects/@current/` (the personal key's scoped project). Returns
 * undefined on any failure — callers soft-fail.
 */
async function discoverProjectId(opts: {
  privateHost: string;
  token: string;
}): Promise<string | undefined> {
  try {
    const response = await fetch(
      new URL("/api/projects/@current/", opts.privateHost).toString(),
      {
        headers: {
          Authorization: `Bearer ${opts.token}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      },
    );
    if (!response.ok) return undefined;
    const data = (await response.json()) as { id?: number | string };
    return data.id !== undefined ? String(data.id) : undefined;
  } catch {
    return undefined;
  }
}

/** Per-(host,credential) one-shot project-id discovery, shared across calls. */
const projectIdCache = new Map<string, Promise<string | undefined>>();

function resolveProjectId(opts: {
  privateHost: string;
  token: string;
  /**
   * Cache identity, NOT the bearer token: OAuth access tokens rotate every
   * ~10h, so keying on `token` would re-discover after every refresh. Callers
   * pass the (stable) personal key or a fixed "oauth" marker.
   */
  cacheKey: string;
  projectId?: string;
}): Promise<string | undefined> {
  if (opts.projectId) return Promise.resolve(opts.projectId);
  const cacheKey = `${opts.privateHost}::${opts.cacheKey}`;
  let pending = projectIdCache.get(cacheKey);
  if (!pending) {
    pending = discoverProjectId(opts).then((id) => {
      // Don't cache a failed discovery — let the next call retry.
      if (id === undefined) projectIdCache.delete(cacheKey);
      return id;
    });
    projectIdCache.set(cacheKey, pending);
  }
  return pending;
}

/**
 * A PostHog person as Hogsend reads it: the canonical person id, the WHOLE
 * distinct_id set the person spans, and the person's properties. Only ever
 * produced for a person that was actually observed — a failed read and an
 * absent person are separate arms of {@link PostHogPersonResult}.
 */
export interface PostHogPersonRecord {
  /**
   * PostHog's CANONICAL person id — `results[0].uuid`, the same value the
   * events table and every query-shaped surface (HogQL, `/api/.../query/`)
   * expose as `person_id`. Deliberately NOT `results[0].id`, which is the
   * Postgres row PK and appears on no other surface: keying a persisted
   * mapping on it makes a later observation through a query path miss and
   * re-resolve every tick. One person id spans MANY distinct_ids, which is
   * exactly why it, and not a distinct_id, is the stable join key.
   */
  personId: string;
  /**
   * EVERY distinct_id PostHog lists under the person, trimmed and
   * de-duplicated. Order carries no meaning — PostHog promises none and it
   * changes between polls — so consumers must normalize before comparing.
   *
   * Surfaced because a caller typically holds only ONE of a person's ids (an
   * anonymous one, say) while the Hogsend contact is keyed on another;
   * resolution needs the whole set to bridge them.
   */
  distinctIds: string[];
  properties: Record<string, unknown>;
}

/** Why an observation did not happen. Never means "no such person". */
export type PostHogPersonReadFailure =
  /** No privileged credential configured — the read never left the process. */
  | "reads_disabled"
  /** The environment/project id could not be resolved. */
  | "no_project"
  /** PostHog answered non-2xx (429 and 5xx land here). */
  | "upstream_error"
  /** The request threw or timed out. */
  | "network_error"
  /** A person came back, but without the uuid needed to key it. */
  | "malformed";

/**
 * The outcome of a person read, with "we looked and there is no such person"
 * kept strictly separate from "we failed to look".
 *
 * DECISIONS §2.6: conflating those two is what turns a rate-limited or
 * expired-token tick into a mass `bucket:left` emission. Callers that diff
 * membership MUST abort on `failed` and may only act on `absent`.
 */
export type PostHogPersonResult =
  | { status: "found"; person: PostHogPersonRecord }
  | { status: "absent" }
  | {
      status: "failed";
      reason: PostHogPersonReadFailure;
      /** Present only for `upstream_error`. */
      statusCode?: number;
    };

/** The subset of PostHog's person payload Hogsend reads. */
interface RawPerson {
  uuid?: unknown;
  distinct_ids?: unknown;
  properties?: Record<string, unknown>;
}

/**
 * The same read as {@link PostHogPersonResult}, but carrying the raw person so
 * {@link getPersonProperties} keeps its pre-existing contract: a person with a
 * missing/odd uuid is unusable to the ID read yet still has readable
 * properties.
 */
type RawPersonResult =
  | { status: "found"; person: RawPerson }
  | { status: "absent" }
  | {
      status: "failed";
      reason: PostHogPersonReadFailure;
      statusCode?: number;
    };

function readFailure(
  reason: PostHogPersonReadFailure,
  statusCode?: number,
): RawPersonResult {
  return statusCode === undefined
    ? { status: "failed", reason }
    : { status: "failed", reason, statusCode };
}

/** Trim, drop non-strings/empties, de-duplicate. Order is left as given. */
function normalizeDistinctIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed) seen.add(trimmed);
  }
  return [...seen];
}

/**
 * The single private-API person read shared by {@link getPersonProperties} and
 * {@link getPerson}. Never throws; every failure path (reads disabled, no
 * token, no project id, non-ok response, a throw) resolves a `failed` arm that
 * is distinct from the `absent` arm. Only `found`/`absent` are safe to cache.
 */
async function fetchPersonRecord(opts: {
  config: PersonPropertiesConfig;
  distinctId: string;
}): Promise<RawPersonResult> {
  const { config, distinctId } = opts;

  if (!config.personalApiKey && !config.getAuthToken) {
    return readFailure("reads_disabled");
  }

  const privateHost = config.privateHost ?? derivePrivateHost(config.host);

  try {
    // OAuth preferred, personal key fallback — a revoked/failed OAuth
    // credential degrades to the personal key for free.
    const oauthToken = config.getAuthToken ? await config.getAuthToken() : null;
    const token = oauthToken ?? config.personalApiKey;
    if (!token) return readFailure("reads_disabled");

    const projectId = await resolveProjectId({
      privateHost,
      token,
      cacheKey: config.personalApiKey ?? "oauth",
      projectId: config.projectId,
    });
    if (!projectId) return readFailure("no_project");

    const url = new URL(
      `/api/environments/${encodeURIComponent(projectId)}/persons/`,
      privateHost,
    );
    url.searchParams.set("distinct_id", distinctId);

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      return readFailure("upstream_error", response.status);
    }

    const data = (await response.json()) as { results?: RawPerson[] };

    const person = data.results?.[0];
    if (!person) return { status: "absent" };

    return { status: "found", person };
  } catch {
    return readFailure("network_error");
  }
}

/**
 * Person READ via PostHog's private API returning the canonical person id, the
 * whole distinct_id set and the properties — the sibling of
 * {@link getPersonProperties}, which returns properties only.
 *
 * Same credential rules, host derivation, project-id caching and timeout as
 * {@link getPersonProperties}, and it likewise never throws. It does NOT share
 * that function's blanket soft-fail: an unknown distinct_id resolves `absent`,
 * while reads-disabled / a revoked token / a 429 / a 5xx / a timeout resolve
 * `failed`. Treating those alike is the mass-leave failure mode DECISIONS §2.6
 * exists to prevent, so the distinction is in the type rather than in a
 * convention callers can forget.
 *
 * Deliberately NOT Redis-cached. The properties cache is keyed by distinct_id
 * and stores a bare property bag; a person record is a different shape, and a
 * stale `personId` is worse than a stale property — callers that map PostHog
 * persons onto Hogsend contacts want the live id.
 */
export async function getPerson(opts: {
  config: PersonPropertiesConfig;
  distinctId: string;
}): Promise<PostHogPersonResult> {
  const result = await fetchPersonRecord(opts);
  if (result.status !== "found") return result;

  const { uuid, distinct_ids, properties } = result.person;
  const personId = typeof uuid === "string" ? uuid.trim() : "";
  // A person we cannot key is an observation we cannot use — and it is
  // emphatically not an absence.
  if (!personId) return { status: "failed", reason: "malformed" };

  return {
    status: "found",
    person: {
      personId,
      distinctIds: normalizeDistinctIds(distinct_ids),
      properties: properties ?? {},
    },
  };
}

/**
 * Person-property READ via PostHog's private API.
 *
 * Requires a privileged credential (scope `person:read`) — the `phc_` project
 * key is write-only by design (it ships in browser bundles) and can never
 * read. An OAuth token (via `getAuthToken`) is preferred; `personalApiKey` is
 * the fallback. With NEITHER configured this resolves `{}` immediately (reads
 * disabled); the engine's timezone fallbacks (contact properties → client
 * default) take over. All upstream errors also soft-fail to `{}`.
 *
 * The private API lives on the APP host (`eu.posthog.com`), not the
 * ingestion host (`eu.i.posthog.com`) — derived via {@link derivePrivateHost}.
 */
export async function getPersonProperties(opts: {
  config: PersonPropertiesConfig;
  distinctId: string;
  cache?: PersonPropertiesCache;
}): Promise<Record<string, unknown>> {
  const { config, distinctId, cache } = opts;

  if (!config.personalApiKey && !config.getAuthToken) return {};

  if (cache) {
    try {
      const cached = await cache.redis.get(`${CACHE_PREFIX}${distinctId}`);
      if (cached) {
        return JSON.parse(cached) as Record<string, unknown>;
      }
    } catch {
      // Cache read or parse failed — fall through to API
    }
  }

  const record = await fetchPersonRecord({ config, distinctId });
  // A failed observation must never be cached as an empty property bag. An
  // observed-absent person legitimately is one, and still caches.
  if (record.status === "failed") return {};

  const properties =
    record.status === "found" ? (record.person.properties ?? {}) : {};

  if (cache) {
    try {
      const ttl = cache.ttlSeconds ?? DEFAULT_TTL;
      await cache.redis.set(
        `${CACHE_PREFIX}${distinctId}`,
        JSON.stringify(properties),
        "EX",
        ttl,
      );
    } catch {
      // Cache write failed — properties were already fetched, continue
    }
  }

  return properties;
}
