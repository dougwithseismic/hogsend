import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../app.js";
import { getRedis } from "../lib/redis.js";

const WINDOW_MS = 60_000;
const MAX_REQUESTS = 100;

const memoryStore = new Map<string, number[]>();
let cleanupCounter = 0;
const MAX_KEYS = 10_000;

export const rateLimit = createMiddleware<AppEnv>(async (c, next) => {
  if (process.env.NODE_ENV === "test") return next();

  const apiKey = c.get("apiKey");
  const keyId = apiKey?.id ?? c.get("user")?.id ?? "anonymous";
  const now = Date.now();

  let count: number;

  try {
    const redis = getRedis();
    if (redis) {
      const windowKey = `ratelimit:${keyId}`;
      const pipeline = redis.pipeline();
      pipeline.zremrangebyscore(windowKey, 0, now - WINDOW_MS);
      pipeline.zcard(windowKey);
      pipeline.zadd(windowKey, now, `${now}:${Math.random()}`);
      pipeline.expire(windowKey, Math.ceil(WINDOW_MS / 1000));

      const results = await pipeline.exec();
      count = (results?.[1]?.[1] as number) ?? 0;
    } else {
      throw new Error("No Redis");
    }
  } catch {
    const entries = memoryStore.get(keyId) ?? [];
    const cutoff = now - WINDOW_MS;
    const valid = entries.filter((t) => t > cutoff);
    valid.push(now);
    memoryStore.set(keyId, valid);
    count = valid.length - 1;

    if (++cleanupCounter % 100 === 0 && memoryStore.size > MAX_KEYS) {
      const sweepCutoff = now - WINDOW_MS;
      for (const [key, entries] of memoryStore) {
        const active = entries.filter((t) => t > sweepCutoff);
        if (active.length === 0) memoryStore.delete(key);
        else memoryStore.set(key, active);
      }
    }
  }

  c.header("X-RateLimit-Limit", String(MAX_REQUESTS));
  c.header(
    "X-RateLimit-Remaining",
    String(Math.max(0, MAX_REQUESTS - count - 1)),
  );

  if (count >= MAX_REQUESTS) {
    return c.json({ error: "Rate limit exceeded" }, 429);
  }

  return next();
});
