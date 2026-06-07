import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../app.js";
import { getRedis } from "../lib/redis.js";

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_REQUESTS = 100;
const DEFAULT_PREFIX = "ratelimit";
const MAX_KEYS = 10_000;

export interface RateLimitOptions {
  windowMs?: number;
  max?: number;
  prefix?: string;
}

/**
 * Build a sliding-window rate-limit middleware.
 *
 * Each instance owns an isolated in-memory fallback store (keyed by `prefix`)
 * and a distinct Redis key namespace, so two middlewares with different
 * prefixes (e.g. "ratelimit" vs "ratelimit:emails") never share a budget —
 * an email send must not consume the contact-upsert sliding window.
 */
export function createRateLimit(opts: RateLimitOptions = {}) {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const max = opts.max ?? DEFAULT_MAX_REQUESTS;
  const prefix = opts.prefix ?? DEFAULT_PREFIX;

  // Per-instance memory store so prefixes stay budget-isolated in the
  // Redis-less fallback path too.
  const memoryStore = new Map<string, number[]>();
  let cleanupCounter = 0;

  return createMiddleware<AppEnv>(async (c, next) => {
    if (process.env.NODE_ENV === "test") return next();

    const apiKey = c.get("apiKey");
    const keyId = apiKey?.id ?? c.get("user")?.id ?? "anonymous";
    const now = Date.now();

    let count: number;

    try {
      const redis = getRedis();
      if (redis) {
        const windowKey = `${prefix}:${keyId}`;
        const pipeline = redis.pipeline();
        pipeline.zremrangebyscore(windowKey, 0, now - windowMs);
        pipeline.zcard(windowKey);
        pipeline.zadd(windowKey, now, `${now}:${Math.random()}`);
        pipeline.expire(windowKey, Math.ceil(windowMs / 1000));

        const results = await pipeline.exec();
        count = (results?.[1]?.[1] as number) ?? 0;
      } else {
        throw new Error("No Redis");
      }
    } catch {
      const entries = memoryStore.get(keyId) ?? [];
      const cutoff = now - windowMs;
      const valid = entries.filter((t) => t > cutoff);
      valid.push(now);
      memoryStore.set(keyId, valid);
      count = valid.length - 1;

      if (++cleanupCounter % 100 === 0 && memoryStore.size > MAX_KEYS) {
        const sweepCutoff = now - windowMs;
        for (const [key, ts] of memoryStore) {
          const active = ts.filter((t) => t > sweepCutoff);
          if (active.length === 0) memoryStore.delete(key);
          else memoryStore.set(key, active);
        }
      }
    }

    c.header("X-RateLimit-Limit", String(max));
    c.header("X-RateLimit-Remaining", String(Math.max(0, max - count - 1)));

    if (count >= max) {
      // SDKs map Retry-After to RateLimitError.retryAfter (seconds).
      c.header("Retry-After", String(Math.ceil(windowMs / 1000)));
      return c.json({ error: "Rate limit exceeded" }, 429);
    }

    return next();
  });
}

export const rateLimit = createRateLimit();
