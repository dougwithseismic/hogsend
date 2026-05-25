import type { PersonPropertiesCache, PersonPropertiesConfig } from "./types.js";

const CACHE_PREFIX = "posthog:person:";
const DEFAULT_TTL = 300;
const FETCH_TIMEOUT_MS = 10_000;

export async function getPersonProperties(opts: {
  config: PersonPropertiesConfig;
  distinctId: string;
  cache?: PersonPropertiesCache;
}): Promise<Record<string, unknown>> {
  const { config, distinctId, cache } = opts;

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

  const url = new URL("/api/persons/", config.host);
  url.searchParams.set("distinct_id", distinctId);

  let properties: Record<string, unknown> = {};

  try {
    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
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
