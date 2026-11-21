import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../app.js";
import { getRedis } from "../lib/redis.js";

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_REQUESTS = 100;
const DEFAULT_PREFIX = "ratelimit";
const MAX_KEYS = 10_000;

/**
 * Every header `createRateLimit` can set. `app.ts` passes this list to the CORS
 * `exposeHeaders` option: none of these is a CORS-safelisted response header,
 * so without it a browser (`@hogsend/js` on a pk_ key) could not read them —
 * including `Retry-After`, which the SDK maps to `RateLimitError.retryAfter`.
 */
export const RATE_LIMIT_HEADERS = [
  "RateLimit-Limit",
  "RateLimit-Remaining",
  "RateLimit-Reset",
  "RateLimit-Policy",
  "X-RateLimit-Limit",
  "X-RateLimit-Remaining",
  "Retry-After",
] as const;

export interface RateLimitOptions {
  windowMs?: number;
  max?: number;
  prefix?: string;
  /**
   * Derive the per-request bucket key. Default keys on the resolved api-key /
   * user id (falling back to "anonymous") — correct for the authenticated data
   * plane. Pass `clientIpKey` for UNAUTHENTICATED surfaces (e.g. the first-admin
   * sign-up gate) where every request would otherwise collapse onto the single
   * "anonymous" bucket and let one attacker exhaust the budget for everyone.
   */
  keyFn?: (c: Context<AppEnv>) => string;
  /**
   * The middleware no-ops under `NODE_ENV=test` by default so the suite isn't
   * throttled. Set `false` to keep it ACTIVE in tests — required to assert the
   * unauthenticated sign-up limiter actually returns 429 past the threshold.
   */
  disableInTest?: boolean;
}

/**
 * Best-effort client IP from the proxy headers Railway/Cloudflare set (same
 * source as `audit.ts` / tracking). Falls back to "unknown" so a request with
 * no forwarded IP still shares a single bounded bucket rather than bypassing.
 */
function clientIp(c: Context<AppEnv>): string {
  return (
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    "unknown"
  );
}

/** Bucket key for unauthenticated, IP-scoped surfaces (e.g. sign-up). */
export function clientIpKey(c: Context<AppEnv>): string {
  return `ip:${clientIp(c)}`;
}

/**
 * Bucket key for the browser-reachable ingest surface (the routes behind
 * `requirePublishableOrIngest`). Runs AFTER that guard, so `apiKey` is set.
 *
 *   - Secret key: one bucket per key. A secret key is one server integration.
 *   - Publishable (pk_) key: one bucket per key PER CLIENT IP. A pk_ key is
 *     public and shared by every visitor of the site, so a per-key bucket
 *     would 429 the whole site once its aggregate traffic crossed the limit,
 *     and would let one client holding the (public) key exhaust everyone's
 *     budget.
 *   - No resolved key (not reachable behind the guard): client IP, so a
 *     misordered mount still never collapses onto one shared bucket.
 */
export function ingestRateLimitKey(c: Context<AppEnv>): string {
  const apiKey = c.get("apiKey");
  if (!apiKey) return clientIpKey(c);
  if (c.get("publishable")) return `pk:${apiKey.id}:${clientIpKey(c)}`;
  return `key:${apiKey.id}`;
}

/**
 * When the next quota unit frees, in ms epoch, for a sliding log.
 *
 * `oldest` is the oldest entry still in the window and `pivot` the max-th
 * newest entry (counting the current request), present only once the log holds
 * `max` or more entries. With room left, the next unit frees when the oldest
 * entry ages out. With none left, the next request is accepted only once the
 * pivot ages out: every entry after it fits under `max`. Rejected requests are
 * logged too, which is why the pivot and not the oldest entry decides.
 */
function nextSlotAt(
  windowMs: number,
  now: number,
  oldest: number | undefined,
  pivot: number | undefined,
): number {
  return (pivot ?? oldest ?? now) + windowMs;
}

/** Parse the `[member, score]` reply of `ZRANGE … WITHSCORES` for one rank. */
function scoreOf(reply: unknown): number | undefined {
  if (!Array.isArray(reply) || reply.length < 2) return undefined;
  const score = Number(reply[1]);
  return Number.isFinite(score) ? score : undefined;
}

/**
 * Build a sliding-window rate-limit middleware.
 *
 * Each instance owns an isolated in-memory fallback store (keyed by `prefix`)
 * and a distinct Redis key namespace, so two middlewares with different
 * prefixes (e.g. "ratelimit" vs "ratelimit:emails") never share a budget —
 * an email send must not consume the contact-upsert sliding window.
 *
 * Headers, on every limited response (allowed or 429):
 *   - `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset` /
 *     `RateLimit-Policy` (IETF draft-ietf-httpapi-ratelimit-headers, the
 *     separate-header form). `RateLimit-Reset` is the seconds until the window
 *     frees the next unit; `RateLimit-Policy` is `<max>;w=<window seconds>`.
 *   - `X-RateLimit-Limit` / `X-RateLimit-Remaining`, kept for existing readers.
 *   - `Retry-After` (seconds) on a 429 only: when the next request is accepted.
 *
 * An instance counts a request at most ONCE, however many matching `use`
 * registrations reach it. Hono runs every matching `use`, and a `/<prefix>/*`
 * pattern also matches the bare `/<prefix>`, so the same instance mounted on
 * overlapping patterns would otherwise log two entries per request and halve
 * the effective budget.
 */
export function createRateLimit(opts: RateLimitOptions = {}) {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const max = opts.max ?? DEFAULT_MAX_REQUESTS;
  const prefix = opts.prefix ?? DEFAULT_PREFIX;
  const disableInTest = opts.disableInTest ?? true;
  const windowSeconds = Math.ceil(windowMs / 1000);
  const policy = `${max};w=${windowSeconds}`;

  // Per-instance memory store so prefixes stay budget-isolated in the
  // Redis-less fallback path too.
  const memoryStore = new Map<string, number[]>();
  let cleanupCounter = 0;
  // Requests this instance has already counted (see the doc comment above).
  // Keyed on the raw Request, which is the same object for every middleware a
  // request passes through; entries go with the request.
  const counted = new WeakSet<Request>();

  return createMiddleware<AppEnv>(async (c, next) => {
    if (disableInTest && process.env.NODE_ENV === "test") return next();
    if (counted.has(c.req.raw)) return next();
    counted.add(c.req.raw);

    const keyId = opts.keyFn
      ? opts.keyFn(c)
      : (c.get("apiKey")?.id ?? c.get("user")?.id ?? "anonymous");
    const now = Date.now();

    let count: number;
    let oldest: number | undefined;
    let pivot: number | undefined;

    try {
      const redis = getRedis();
      if (redis) {
        const windowKey = `${prefix}:${keyId}`;
        const pipeline = redis.pipeline();
        pipeline.zremrangebyscore(windowKey, 0, now - windowMs);
        pipeline.zcard(windowKey);
        pipeline.zadd(windowKey, now, `${now}:${Math.random()}`);
        pipeline.expire(windowKey, windowSeconds);
        // Two O(log n) rank reads for RateLimit-Reset / Retry-After: the
        // oldest entry, and the max-th newest (empty while under `max`).
        pipeline.zrange(windowKey, 0, 0, "WITHSCORES");
        pipeline.zrange(windowKey, -max, -max, "WITHSCORES");

        const results = await pipeline.exec();
        count = (results?.[1]?.[1] as number) ?? 0;
        oldest = scoreOf(results?.[4]?.[1]);
        pivot = scoreOf(results?.[5]?.[1]);
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
      oldest = valid[0];
      pivot = valid.length >= max ? valid[valid.length - max] : undefined;

      if (++cleanupCounter % 100 === 0 && memoryStore.size > MAX_KEYS) {
        const sweepCutoff = now - windowMs;
        for (const [key, ts] of memoryStore) {
          const active = ts.filter((t) => t > sweepCutoff);
          if (active.length === 0) memoryStore.delete(key);
          else memoryStore.set(key, active);
        }
      }
    }

    const remaining = Math.max(0, max - count - 1);
    const resetSeconds = Math.max(
      1,
      Math.ceil((nextSlotAt(windowMs, now, oldest, pivot) - now) / 1000),
    );

    c.header("RateLimit-Limit", String(max));
    c.header("RateLimit-Remaining", String(remaining));
    c.header("RateLimit-Reset", String(resetSeconds));
    c.header("RateLimit-Policy", policy);
    c.header("X-RateLimit-Limit", String(max));
    c.header("X-RateLimit-Remaining", String(remaining));

    if (count >= max) {
      // SDKs map Retry-After to RateLimitError.retryAfter (seconds).
      c.header("Retry-After", String(resetSeconds));
      return c.json({ error: "Rate limit exceeded" }, 429);
    }

    return next();
  });
}

export const rateLimit = createRateLimit();

/**
 * Data-plane budget defaults. `env.ts` declares the matching variables as
 * optional so these stay the one place the numbers live.
 *
 * - Secret key on the ingest routes: 3000/min (50 req/s sustained). A secret
 *   key is usually one backend forwarding every user's events, and there is no
 *   batch event endpoint, so the budget has to cover a busy production app; it
 *   still stops a runaway loop well before it saturates an API instance.
 * - Publishable key on the ingest routes: 1000/min per client IP. A browser on
 *   `@hogsend/js` makes a few requests a minute (one per captured event, plus a
 *   feed poll every 12s), so this leaves room for many visitors behind one
 *   office or carrier NAT while capping a single client that holds the public
 *   key.
 * - `/v1/emails`: 30/min per key (unchanged). A loop sending more than that is
 *   almost certainly a runaway.
 */
export const DEFAULT_INGEST_RATE_LIMIT_MAX = 3000;
export const DEFAULT_INGEST_PUBLIC_RATE_LIMIT_MAX = 1000;
export const DEFAULT_INGEST_RATE_LIMIT_WINDOW_MS = 60_000;
export const DEFAULT_EMAIL_RATE_LIMIT_MAX = 30;

export interface IngestRateLimitOptions {
  /** Requests per window per secret key. */
  max?: number;
  /** Requests per window per publishable key per client IP. */
  publicMax?: number;
  windowMs?: number;
  disableInTest?: boolean;
}

/**
 * The rate limit for the browser-reachable ingest routes. Two isolated budgets
 * (own prefixes, so neither shares a window with `/v1/emails` or the admin
 * plane), picked by the key class `requirePublishableOrIngest` resolved. Mount
 * it AFTER that guard: the bucket key and the budget both read what the guard
 * set (`apiKey`, `publishable`).
 */
export function createIngestRateLimit(opts: IngestRateLimitOptions = {}) {
  const windowMs = opts.windowMs ?? DEFAULT_INGEST_RATE_LIMIT_WINDOW_MS;
  const secret = createRateLimit({
    prefix: "ratelimit:ingest",
    max: opts.max ?? DEFAULT_INGEST_RATE_LIMIT_MAX,
    windowMs,
    keyFn: ingestRateLimitKey,
    disableInTest: opts.disableInTest,
  });
  const publishable = createRateLimit({
    prefix: "ratelimit:ingest-public",
    max: opts.publicMax ?? DEFAULT_INGEST_PUBLIC_RATE_LIMIT_MAX,
    windowMs,
    keyFn: ingestRateLimitKey,
    disableInTest: opts.disableInTest,
  });
  return createMiddleware<AppEnv>((c, next) =>
    c.get("publishable") ? publishable(c, next) : secret(c, next),
  );
}
