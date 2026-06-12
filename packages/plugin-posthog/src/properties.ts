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
 * Resolve the project id for environment-scoped private endpoints via
 * `GET /api/projects/@current/` (the personal key's scoped project). Returns
 * undefined on any failure — callers soft-fail.
 */
async function discoverProjectId(opts: {
  privateHost: string;
  personalApiKey: string;
}): Promise<string | undefined> {
  try {
    const response = await fetch(
      new URL("/api/projects/@current/", opts.privateHost).toString(),
      {
        headers: {
          Authorization: `Bearer ${opts.personalApiKey}`,
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

/** Per-(host,key) one-shot project-id discovery, shared across calls. */
const projectIdCache = new Map<string, Promise<string | undefined>>();

function resolveProjectId(opts: {
  privateHost: string;
  personalApiKey: string;
  projectId?: string;
}): Promise<string | undefined> {
  if (opts.projectId) return Promise.resolve(opts.projectId);
  const cacheKey = `${opts.privateHost}::${opts.personalApiKey}`;
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
 * Requires a PERSONAL API key (scope `person:read`) — the `phc_` project key
 * is write-only by design (it ships in browser bundles) and can never read.
 * Without `personalApiKey` this resolves `{}` immediately (reads disabled);
 * the engine's timezone fallbacks (contact properties → client default) take
 * over. All upstream errors also soft-fail to `{}`.
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

  if (!config.personalApiKey) return {};

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
    const projectId = await resolveProjectId({
      privateHost,
      personalApiKey: config.personalApiKey,
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
        Authorization: `Bearer ${config.personalApiKey}`,
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
