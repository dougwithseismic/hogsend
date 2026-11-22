import { type Database, webhookEndpoints } from "@hogsend/db";
import { and, eq, isNull } from "drizzle-orm";

/** How long the enabled-endpoint list is reused before a re-read. */
const DEFAULT_ENDPOINT_CACHE_TTL_MS = 30_000;

interface CachedEndpoint {
  id: string;
  eventTypes: string[];
}

interface CacheEntry {
  rows: CachedEndpoint[];
  loadedAt: number;
  generation: number;
}

// One entry per database client, so two databases in one process (tests,
// a multi-database host) never read each other's endpoints.
const endpointCache = new WeakMap<Database, CacheEntry>();
// Bumped by every invalidation. An entry from an older generation is ignored,
// and a read that started before an admin write can't put the pre-write list
// back into the cache when it finishes.
let endpointCacheGeneration = 0;

function endpointCacheTtlMs(): number {
  const raw = process.env.OUTBOUND_ENDPOINT_CACHE_TTL_MS;
  if (raw === undefined || raw === "") return DEFAULT_ENDPOINT_CACHE_TTL_MS;
  const ttl = Number(raw);
  return Number.isFinite(ttl) && ttl >= 0 ? ttl : DEFAULT_ENDPOINT_CACHE_TTL_MS;
}

/**
 * Drop the cached endpoint list so the next emit re-reads `webhook_endpoints`.
 * Every engine writer of that table calls this (the admin webhook routes and
 * the PostHog destination seed). It only clears THIS process: another API
 * instance or the worker picks the change up when its own copy expires
 * (`OUTBOUND_ENDPOINT_CACHE_TTL_MS`, default 30 s). A disabled or deleted
 * endpoint, or an event it was just unsubscribed from, is still never sent to
 * inside that window: the delivery task re-reads the endpoint row before every
 * attempt. `emitOutbound` retries once on the foreign-key error a deleted
 * cached endpoint causes, so the other endpoints keep their delivery.
 */
export function invalidateOutboundEndpointCache(): void {
  endpointCacheGeneration += 1;
}

/**
 * Every enabled single-tenant endpoint with its subscriptions, read at most
 * once per TTL. The per-event filter runs in memory: an install has a handful
 * of endpoints, and this saves a query on every outbound emit.
 */
export async function loadSubscribableEndpoints(
  db: Database,
): Promise<CachedEndpoint[]> {
  const ttl = endpointCacheTtlMs();
  const now = Date.now();
  const cached = ttl > 0 ? endpointCache.get(db) : undefined;
  if (
    cached &&
    cached.generation === endpointCacheGeneration &&
    now - cached.loadedAt < ttl
  ) {
    return cached.rows;
  }
  const generation = endpointCacheGeneration;
  const rows = await db
    .select({
      id: webhookEndpoints.id,
      eventTypes: webhookEndpoints.eventTypes,
    })
    .from(webhookEndpoints)
    .where(
      and(
        eq(webhookEndpoints.disabled, false),
        isNull(webhookEndpoints.organizationId),
      ),
    );
  if (ttl > 0 && generation === endpointCacheGeneration) {
    endpointCache.set(db, { rows, loadedAt: now, generation });
  }
  return rows;
}
