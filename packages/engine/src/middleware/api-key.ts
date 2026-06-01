import { apiKeys } from "@hogsend/db";
import { and, eq, isNull } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../app.js";
import { hashApiKey } from "../lib/api-key-hash.js";

export interface ApiKeyContext {
  id: string;
  name: string;
  scopes: string[];
}

const SCOPE_HIERARCHY: Record<string, number> = {
  read: 0,
  "journey-admin": 1,
  "full-admin": 2,
};

const KEY_CACHE = new Map<
  string,
  {
    data: ApiKeyContext & { expiresAt: Date | null; lastUsedAt: Date | null };
    cachedAt: number;
  }
>();
const CACHE_TTL = 60_000;
const LAST_USED_DEBOUNCE = 5 * 60_000;

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

  const keyHash = hashApiKey(provided);

  const cached = KEY_CACHE.get(keyHash);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL) {
    if (cached.data.expiresAt && cached.data.expiresAt < new Date()) {
      return c.json({ error: "API key expired" }, 401);
    }
    c.set("apiKey", {
      id: cached.data.id,
      name: cached.data.name,
      scopes: cached.data.scopes,
    });
    return next();
  }

  const rows = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, keyHash), isNull(apiKeys.revokedAt)))
    .limit(1);

  const key = rows[0];
  if (!key) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  if (key.expiresAt && key.expiresAt < new Date()) {
    return c.json({ error: "API key expired" }, 401);
  }

  const keyContext: ApiKeyContext = {
    id: key.id,
    name: key.name,
    scopes: key.scopes as string[],
  };

  c.set("apiKey", keyContext);

  KEY_CACHE.set(keyHash, {
    data: {
      ...keyContext,
      expiresAt: key.expiresAt,
      lastUsedAt: key.lastUsedAt,
    },
    cachedAt: Date.now(),
  });

  const shouldUpdateLastUsed =
    !key.lastUsedAt ||
    Date.now() - key.lastUsedAt.getTime() > LAST_USED_DEBOUNCE;

  if (shouldUpdateLastUsed) {
    db.update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, key.id))
      .then(() => {})
      .catch(() => {});
  }

  return next();
});

export function requireScope(scope: string) {
  const required = SCOPE_HIERARCHY[scope] ?? 0;

  return createMiddleware<AppEnv>(async (c, next) => {
    const apiKey = c.get("apiKey");
    if (!apiKey) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const maxScope = Math.max(
      ...apiKey.scopes.map((s: string) => SCOPE_HIERARCHY[s] ?? 0),
    );

    if (maxScope < required) {
      return c.json({ error: "Forbidden: insufficient scope" }, 403);
    }

    return next();
  });
}
