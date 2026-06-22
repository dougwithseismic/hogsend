import { randomBytes } from "node:crypto";
import { getRedis } from "../lib/redis.js";

/** Default time-to-live for a cold-connect confirm token (seconds). */
export const COLD_CONNECT_DEFAULT_TTL_SECONDS = 900;

/**
 * The sealed cold-connect binding. The `connectorId` is sealed IN the value so
 * the exchange route can assert it matches the route it was redeemed on
 * (cross-connector token isolation): a token minted for one connector can never
 * be redeemed by another, even if a composer miswires the mounts.
 */
export interface ColdConnectBinding<S = Record<string, unknown>> {
  connectorId: string;
  platformUserId: string;
  email: string;
  /** Caller-supplied extra scalars carried through to the exchange. */
  scalars?: S;
}

/**
 * The Redis key for a cold-connect token. Namespaced per connector so two
 * connectors' token spaces never collide and a peek/consume scoped to one
 * connector can never touch another's.
 */
function tokenKey(connectorId: string, token: string): string {
  return `hogsend:cc:${connectorId}:${token}`;
}

/** An opaque, URL-safe token (32 hex chars). */
function randomToken(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Mint a cold-connect confirm token sealing `{ connectorId, platformUserId,
 * email, scalars }` server-side in Redis (TTL-bounded). The token rides in a
 * link emailed to that address — clicking it proves inbox ownership. The web
 * caller never names the platform id OR an arbitrary email; both come from the
 * server-sealed token, not the request. Returns the token, or `null` when Redis
 * is unavailable (fail-closed — the caller must not send a link it can't honor).
 */
export async function mintColdConnectToken<S = Record<string, unknown>>(args: {
  binding: ColdConnectBinding<S>;
  ttlSeconds?: number;
}): Promise<string | null> {
  const redis = getRedis();
  if (!redis) return null;
  const token = randomToken();
  try {
    await redis.set(
      tokenKey(args.binding.connectorId, token),
      JSON.stringify(args.binding),
      "EX",
      args.ttlSeconds ?? COLD_CONNECT_DEFAULT_TTL_SECONDS,
    );
  } catch {
    return null;
  }
  return token;
}

/**
 * PEEK a token's sealed binding WITHOUT consuming it (Redis GET). The exchange
 * consumes the token only AFTER the bind ingest commits, so a transient failure
 * doesn't burn the user's single click. Returns `null` on unknown/expired/
 * malformed token.
 */
export async function peekColdConnectToken<S = Record<string, unknown>>(args: {
  connectorId: string;
  token: string;
}): Promise<ColdConnectBinding<S> | null> {
  const redis = getRedis();
  if (!redis) return null;
  let raw: string | null;
  try {
    raw = await redis.get(tokenKey(args.connectorId, args.token));
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const b = JSON.parse(raw) as ColdConnectBinding<S>;
    if (
      b &&
      typeof b.connectorId === "string" &&
      typeof b.platformUserId === "string" &&
      typeof b.email === "string"
    ) {
      return b;
    }
  } catch {
    // malformed binding — treat as a miss
  }
  return null;
}

/**
 * Consume (single-use delete) a token AFTER its bind ingest has committed.
 * Idempotent: a second click then sees the token gone. Best-effort — a Redis
 * blip here leaves the token to expire on its TTL.
 */
export async function consumeColdConnectToken(args: {
  connectorId: string;
  token: string;
}): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.del(tokenKey(args.connectorId, args.token));
  } catch {
    // Degrade to no-op — the TTL bounds single-use anyway.
  }
}

/**
 * Build the email-confirmation connect URL on the customer's own API_PUBLIC_URL.
 * The path is derived from `connectorId` (`/connect/<connectorId>?tok=…`) — the
 * same basePath `cc.routes` mounts, so a minted URL always resolves.
 */
export function buildColdConnectUrl(args: {
  apiPublicUrl: string;
  connectorId: string;
  token: string;
}): string {
  const base = args.apiPublicUrl.replace(/\/$/, "");
  return `${base}/connect/${args.connectorId}?tok=${encodeURIComponent(
    args.token,
  )}`;
}
