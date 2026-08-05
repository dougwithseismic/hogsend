import { lt, sql } from "drizzle-orm";
import type { CloudDb } from "../db";
import { db as defaultDb } from "../db";
import { cliRateLimits } from "../db/schema";
import { env } from "../env";

/**
 * A fixed-window request counter, in Postgres.
 *
 * CHOICE, stated once so it is not rediscovered: this is a TABLE, not an
 * in-memory LRU. The device-flow endpoints are unauthenticated and the control
 * plane is expected to run more than one Next.js instance, so a per-process
 * counter would silently multiply every limit by the replica count — which is
 * precisely the failure a brute-force limit may not have. The cost is one
 * upsert per request on two small endpoints, and the increment is a single
 * statement (`count = count + 1 RETURNING count`) so two replicas racing the
 * same window serialise on the row instead of both reading a stale count.
 *
 * A fixed window (rather than a sliding one) is deliberate too: it is one row
 * and one statement, and the worst case it admits — twice the limit across a
 * window boundary — is irrelevant against a code space this large.
 *
 * The rows are garbage, not records. Nothing reads a window once it has passed,
 * and each new window prunes the old ones as it opens.
 */

export interface RateLimitDecision {
  allowed: boolean;
  /** Requests counted in this window INCLUDING the current one. */
  count: number;
  limit: number;
  /** Seconds until the window rolls — what a `retry-after` header carries. */
  retryAfterSeconds: number;
}

export interface RateLimitInput {
  /** `<scope>:<identity>`, e.g. `cli_device_mint:203.0.113.9`. */
  bucket: string;
  limit: number;
  windowMs: number;
  /** Injected by tests so a window boundary is reachable without waiting. */
  now?: Date;
  db?: CloudDb;
}

/** How many stale windows are kept before the opening of a new one sweeps. */
const PRUNE_WINDOWS = 4;

/**
 * Count one request against `bucket` and say whether it is allowed.
 *
 * ALWAYS counts, including when it refuses: a caller hammering a refused
 * endpoint must not reset its own budget by being refused.
 */
export async function consumeRateLimit(
  input: RateLimitInput,
): Promise<RateLimitDecision> {
  const db = input.db ?? defaultDb;
  const now = input.now ?? new Date();
  const windowStart = new Date(
    Math.floor(now.getTime() / input.windowMs) * input.windowMs,
  );

  const [row] = await db
    .insert(cliRateLimits)
    .values({ bucket: input.bucket, windowStart, count: 1 })
    .onConflictDoUpdate({
      target: [cliRateLimits.bucket, cliRateLimits.windowStart],
      set: { count: sql`${cliRateLimits.count} + 1` },
    })
    .returning({ count: cliRateLimits.count });

  const count = row?.count ?? 1;

  // Exactly once per bucket per window — the request that OPENED it — retire
  // the windows nobody will read again. Cheap, indexed, and deterministic:
  // no sampling, no cron, no unbounded table.
  if (count === 1) {
    await db
      .delete(cliRateLimits)
      .where(
        lt(
          cliRateLimits.windowStart,
          new Date(windowStart.getTime() - PRUNE_WINDOWS * input.windowMs),
        ),
      );
  }

  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((windowStart.getTime() + input.windowMs - now.getTime()) / 1000),
  );

  return {
    allowed: count <= input.limit,
    count,
    limit: input.limit,
    retryAfterSeconds,
  };
}

/**
 * The caller's address, as far as a proxied request can be TRUSTED to say it.
 *
 * `x-forwarded-for` is append-only and CLIENT-WRITABLE: each hop appends the
 * peer it observed, so the leftmost entry is whatever the original caller put
 * in the header and only the rightmost entries were written by proxies. Reading
 * the first entry — the conventional "the client is hop one" — therefore hands
 * an attacker a fresh bucket per request just by rotating a header value, which
 * is not a rate limit at all. So the address is counted from the RIGHT: with
 * `hops` trusted proxies in front of this app, the address the innermost
 * trusted proxy observed sits `hops` from the end.
 *
 * Anything else — no header, or a chain SHORTER than the trusted depth (a
 * request that did not arrive through those proxies) — buckets under `unknown`,
 * one shared budget. That is the safe direction: it can only make the limit
 * tighter. `x-real-ip` is deliberately NOT a fallback, because on a deployment
 * where no proxy sets it, it is just another string the caller chose.
 */
export function clientIp(
  headers: Headers,
  hops: number = env.CLOUD_TRUSTED_PROXY_HOPS,
): string {
  const chain = headers.get("x-forwarded-for")?.split(",") ?? [];
  const entry = chain[chain.length - Math.max(1, Math.trunc(hops))]?.trim();
  if (entry) return entry.slice(0, 64);
  return "unknown";
}

/**
 * Count one request against BOTH an email bucket and an IP bucket.
 *
 * The two axes stop different attacks and are therefore not interchangeable:
 * the EMAIL bucket is the one an attacker cannot rotate (it is the identifier
 * the code is mailed to), and the IP bucket is what stops one caller walking a
 * list of addresses. A limiter with only one of them is missing half the
 * attack surface.
 *
 * BOTH ARE ALWAYS CONSUMED, including when the first already refuses. That is
 * the invariant this helper exists to hold: short-circuiting on the email
 * bucket would let a caller hammer one address to exhaustion and then keep a
 * pristine IP budget for the next one. `consumeRateLimit` counts refusals too
 * (see its own note), and these two calls are unconditional writes to
 * different rows, so running them in parallel is identical in effect to
 * running them in sequence.
 *
 * The returned `retryAfterSeconds` is the LONGER of the two windows that
 * refused — telling a caller to retry before the other bucket has rolled would
 * be advice that earns them a second refusal.
 */
export async function consumeDualRateLimit(input: {
  /** Already lowercased by the caller: one inbox must not be two budgets. */
  email: string;
  ip: string;
  emailLimit: number;
  ipLimit: number;
  windowMs: number;
  /** Bucket namespace, e.g. `cli_signup` → `cli_signup_email:` / `_ip:`. */
  prefix: string;
  now?: Date;
  db?: CloudDb;
}): Promise<RateLimitDecision> {
  const common = {
    windowMs: input.windowMs,
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.db === undefined ? {} : { db: input.db }),
  };

  const [perEmail, perIp] = await Promise.all([
    consumeRateLimit({
      bucket: `${input.prefix}_email:${input.email}`,
      limit: input.emailLimit,
      ...common,
    }),
    consumeRateLimit({
      bucket: `${input.prefix}_ip:${input.ip}`,
      limit: input.ipLimit,
      ...common,
    }),
  ]);

  const allowed = perEmail.allowed && perIp.allowed;
  return {
    allowed,
    // The bucket that refused is the one a caller needs reported; when both
    // allowed, the counts are per-bucket and the email one is the meaningful
    // half (an IP may legitimately carry several people).
    count: perEmail.count,
    limit: perEmail.limit,
    retryAfterSeconds: Math.max(
      perEmail.allowed ? 0 : perEmail.retryAfterSeconds,
      perIp.allowed ? 0 : perIp.retryAfterSeconds,
    ),
  };
}
