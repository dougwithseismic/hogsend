import { apiKeys, type Database } from "@hogsend/db";
import { and, eq, isNull } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../app.js";
import { hashApiKey } from "../lib/api-key-hash.js";

export interface ApiKeyContext {
  id: string;
  name: string;
  scopes: string[];
  // Set ONLY by `requirePublishableOrIngest` for a publishable (pk_) key — the
  // per-key browser Origin allowlist. `requireApiKey` (the secret path) never
  // populates it, so its behavior is unchanged.
  allowedOrigins?: string[] | null;
}

const SCOPE_HIERARCHY: Record<string, number> = {
  read: 0,
  "journey-admin": 1,
  "full-admin": 2,
};

/**
 * Single source of truth for scope checks.
 *
 * - Hierarchical scopes (`read` < `journey-admin` < `full-admin`): the key
 *   passes when the MAX hierarchical rank it holds is >= the required rank.
 * - Orthogonal scopes (e.g. `ingest`): NOT part of the hierarchy. A key must
 *   either be granted the scope explicitly OR hold `full-admin` (which implies
 *   every orthogonal data-plane scope).
 *
 * This fixes the latent bug where an orthogonal required scope was looked up in
 * SCOPE_HIERARCHY (`?? 0`), letting ANY authenticated key satisfy it.
 */
export function hasScope(keyScopes: string[], required: string): boolean {
  const requiredRank = SCOPE_HIERARCHY[required];

  if (requiredRank === undefined) {
    // Orthogonal scope (e.g. "ingest"): explicit grant or full-admin implies it.
    return keyScopes.includes(required) || keyScopes.includes("full-admin");
  }

  // Hierarchical scope: highest rank held must clear the required rank.
  let maxRank = Number.NEGATIVE_INFINITY;
  for (const scope of keyScopes) {
    const rank = SCOPE_HIERARCHY[scope];
    if (rank !== undefined && rank > maxRank) {
      maxRank = rank;
    }
  }

  return maxRank >= requiredRank;
}

/** An `api_keys` row as both auth guards need it, cached per process. */
export interface CachedApiKey extends ApiKeyContext {
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  allowedOrigins: string[] | null;
}

const KEY_CACHE = new Map<string, { data: CachedApiKey; cachedAt: number }>();
const CACHE_TTL = 60_000;
const LAST_USED_DEBOUNCE = 5 * 60_000;

/**
 * Drop a key's cached auth entry so THIS process re-reads the row on the key's
 * next request. Called after a revoke or a rotation changes the row. The cache
 * is per process: other API instances keep their entry until its TTL (60s)
 * runs out, which is the documented revocation lag.
 */
export function evictCachedApiKey(keyHash: string): void {
  KEY_CACHE.delete(keyHash);
}

/**
 * Read a live (unrevoked) key by hash through the 60s per-process cache, for
 * secret and publishable keys alike. Misses are not cached, so a key minted a
 * moment ago works on its first request. Expiry is the caller's check (it is
 * re-evaluated on every request, cached or not). On a cache fill, `lastUsedAt`
 * is bumped fire-and-forget at most once per five minutes.
 */
export async function loadApiKey(
  db: Database,
  keyHash: string,
): Promise<CachedApiKey | null> {
  const cached = KEY_CACHE.get(keyHash);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL) {
    return cached.data;
  }

  const rows = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, keyHash), isNull(apiKeys.revokedAt)))
    .limit(1);
  const key = rows[0];
  if (!key) return null;

  const data: CachedApiKey = {
    id: key.id,
    name: key.name,
    scopes: key.scopes as string[],
    expiresAt: key.expiresAt,
    lastUsedAt: key.lastUsedAt,
    allowedOrigins: key.allowedOrigins ?? null,
  };
  KEY_CACHE.set(keyHash, { data, cachedAt: Date.now() });

  if (
    !key.lastUsedAt ||
    Date.now() - key.lastUsedAt.getTime() > LAST_USED_DEBOUNCE
  ) {
    db.update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, key.id))
      .then(() => {})
      .catch(() => {});
  }

  return data;
}

export const requireApiKey = createMiddleware<AppEnv>(async (c, next) => {
  const { env, db } = c.get("container");

  const header = c.req.header("authorization");
  const provided = header?.startsWith("Bearer ") ? header.slice(7) : undefined;

  if (!provided) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  if (env.ADMIN_API_KEY && provided === env.ADMIN_API_KEY) {
    c.set("apiKey", {
      id: "legacy",
      name: "legacy",
      scopes: ["full-admin"],
    });
    return next();
  }

  const key = await loadApiKey(db, hashApiKey(provided));
  if (!key) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  if (key.expiresAt && key.expiresAt < new Date()) {
    return c.json({ error: "API key expired" }, 401);
  }

  c.set("apiKey", { id: key.id, name: key.name, scopes: key.scopes });
  return next();
});

export function requireScope(scope: string) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const apiKey = c.get("apiKey");
    if (!apiKey) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    if (!hasScope(apiKey.scopes, scope)) {
      return c.json({ error: "Forbidden: insufficient scope" }, 403);
    }

    return next();
  });
}
