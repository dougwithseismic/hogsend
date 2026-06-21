import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import { getRedis } from "./redis.js";

/**
 * A connector-neutral distributed leader lease over Redis. The connector runtime
 * needs EXACTLY ONE process (across N replicated Hatchet workers) to hold a given
 * platform socket at a time — one bot token permits one live Gateway session — so
 * the runtime races for a lease keyed by connector id and only the winner opens
 * the socket. Losers idle and re-race, giving bounded automatic failover within
 * the TTL with no two-holders overlap.
 *
 * The lease is a `SET key token NX PX ttl` (atomic acquire-if-absent with an
 * expiry), renewed by a Lua compare-then-PEXPIRE and released by a Lua
 * compare-then-DEL. The compare on the caller's unique `token` is the fence: a
 * process that has LOST the lease (expired, taken over) can neither renew nor
 * release it, so it can never stomp the new holder. Built on the shared engine
 * Redis singleton ({@link getRedis}); every op accepts an explicit client for
 * tests.
 *
 * Everything is best-effort against Redis faults: acquire/renew return `false`
 * (caller stays/loses leader, never opens a second socket), release swallows.
 * Fail-safe means "no lease ⇒ no socket", never "two sockets".
 */

/** Renew the lease ONLY if we still own it, then extend its expiry. */
const RENEW_LUA =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end';

/** Delete the lease ONLY if we still own it (never delete someone else's). */
const RELEASE_LUA =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

/** A process-unique fencing token to stamp on an acquired lease. */
export function newLeaseToken(): string {
  return randomUUID();
}

/**
 * Try to acquire the lease. Returns `true` only when this call set the key (it
 * was absent). A `false` means another holder owns it OR Redis is unreachable —
 * either way the caller must NOT open the socket.
 */
export async function acquireLeaderLease(args: {
  key: string;
  token: string;
  ttlMs: number;
  redis?: Redis;
}): Promise<boolean> {
  const redis = args.redis ?? getRedis();
  try {
    const res = await redis.set(args.key, args.token, "PX", args.ttlMs, "NX");
    return res === "OK";
  } catch {
    return false;
  }
}

/**
 * Renew our hold on the lease (compare-and-extend). Returns `false` if we no
 * longer own it (expired / taken over) or Redis is unreachable — the caller must
 * then self-demote and stop the socket.
 */
export async function renewLeaderLease(args: {
  key: string;
  token: string;
  ttlMs: number;
  redis?: Redis;
}): Promise<boolean> {
  const redis = args.redis ?? getRedis();
  try {
    const res = await redis.eval(
      RENEW_LUA,
      1,
      args.key,
      args.token,
      String(args.ttlMs),
    );
    return res === 1;
  } catch {
    return false;
  }
}

/**
 * Release the lease if (and only if) we still own it. Best-effort: a failure is
 * swallowed because the TTL expires the key anyway. Returns `true` when our own
 * key was deleted.
 */
export async function releaseLeaderLease(args: {
  key: string;
  token: string;
  redis?: Redis;
}): Promise<boolean> {
  const redis = args.redis ?? getRedis();
  try {
    const res = await redis.eval(RELEASE_LUA, 1, args.key, args.token);
    return res === 1;
  } catch {
    return false;
  }
}
