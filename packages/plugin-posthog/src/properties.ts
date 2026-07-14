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

  const privateHost = config.privateHost ?? derivePrivateHost(config.host);

  let properties: Record<string, unknown> = {};

  try {
    // OAuth preferred, personal key fallback — a revoked/failed OAuth
    // credential degrades to the personal key for free.
    const oauthToken = config.getAuthToken ? await config.getAuthToken() : null;
    const token = oauthToken ?? config.personalApiKey;
    if (!token) return {};

    const projectId = await resolveProjectId({
      privateHost,
      token,
      cacheKey: config.personalApiKey ?? "oauth",
      projectId: config.projectId,
    });
    if (!projectId) return {};

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
      return {};
    }

    const data = (await response.json()) as {
      results?: Array<{ properties?: Record<string, unknown> }>;
    };

    properties = data.results?.[0]?.properties ?? {};
  } catch {
    return {};
  }

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
