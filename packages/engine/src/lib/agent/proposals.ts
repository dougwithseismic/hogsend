import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { getRedis } from "../redis.js";
import { baseTier, type Tier } from "./risk.js";

/**
 * HITL proposal token. A write tool mints one and returns it WITHOUT performing
 * the side effect; the operator clicks confirm and POST /v1/admin/agent/confirm
 * verifies+burns it and runs the real write — the ONLY place a write executes.
 *
 * ENCRYPTED (AES-256-GCM keyed off BETTER_AUTH_SECRET): the token rides in
 * browser memory and the confirm POST; the GCM tag covers integrity so a
 * tampered token fails decryption. The ARGS are NOT in the token — only
 * `proposalId` is. The args are stored server-side in Redis keyed by that id, so
 * (a) the token stays small, (b) args can't be swapped onto another tool's
 * token, and (c) the single-use burn is one atomic Redis op on the id.
 */
const TTL_SECONDS = 10 * 60; // 10-minute confirm window — Redis TTL === token exp
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const REDIS_PREFIX = "hogsend:agent:proposal:";

export interface ProposalPayload {
  proposalId: string;
  tool: string;
  tier: Tier;
  /** The operator who minted it. Confirm asserts this === the confirming actor. */
  actorEmail: string;
  /** Optional chat session id for correlation/audit. */
  sessionId?: string;
  exp: number;
}

/** The verified proposal the confirm route acts on: token claims + burned args. */
export interface VerifiedProposal extends ProposalPayload {
  args: Record<string, unknown>;
}

export class InvalidProposalError extends Error {
  /** `redis_unavailable` ⇒ retryable infra error (confirm route maps to 503);
   * otherwise a terminal token problem (burned/expired/bad ⇒ 410). */
  constructor(
    message: string,
    public readonly code?: "redis_unavailable",
  ) {
    super(message);
    this.name = "InvalidProposalError";
  }
}

function deriveKey(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

function redisKey(proposalId: string): string {
  return `${REDIS_PREFIX}${proposalId}`;
}

/**
 * Mint a proposal: stash the args in Redis under a fresh id (SET NX EX, 10 min),
 * then return an encrypted token carrying the id + tool + tier + actor. The
 * caller (a write tool's execute) returns `{ status: "needs_confirmation", token,
 * proposalId, ... }` and does NOT perform the side effect.
 */
export async function mintProposal(opts: {
  secret: string;
  tool: string;
  args: Record<string, unknown>;
  tier?: Tier;
  actorEmail: string;
  sessionId?: string;
}): Promise<{ proposalId: string; token: string; expiresAt: string }> {
  const proposalId = randomUUID();
  const tier = opts.tier ?? baseTier(opts.tool);
  const exp = Math.floor(Date.now() / 1000) + TTL_SECONDS;

  // Store the args server-side, NX so a (cosmically unlikely) uuid collision can
  // never overwrite a live proposal's args.
  const redis = getRedis();
  let ok: string | null;
  try {
    ok = await redis.set(
      redisKey(proposalId),
      JSON.stringify({ tool: opts.tool, args: opts.args }),
      "EX",
      TTL_SECONDS,
      "NX",
    );
  } catch {
    throw new InvalidProposalError("Redis unavailable", "redis_unavailable");
  }
  if (ok !== "OK") {
    throw new InvalidProposalError("Failed to persist proposal args");
  }

  const payload: ProposalPayload = {
    proposalId,
    tool: opts.tool,
    tier,
    actorEmail: opts.actorEmail,
    sessionId: opts.sessionId,
    exp,
  };

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(opts.secret), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf-8"),
    cipher.final(),
  ]);
  const token = Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString(
    "base64url",
  );

  return { proposalId, token, expiresAt: new Date(exp * 1000).toISOString() };
}

// Atomic single-use burn: read the args then delete in one round-trip. Returns
// the JSON string or nil — a second confirm finds nil (already burned/expired).
const BURN_LUA =
  "local v = redis.call('GET', KEYS[1]); if v then redis.call('DEL', KEYS[1]) end; return v";

/**
 * Verify a proposal token AND burn its args atomically (single-use). Throws
 * {@link InvalidProposalError} on: malformed/tampered token (GCM failure),
 * expired token, or a burned/expired Redis entry (replay). On success the args
 * are gone from Redis — a second call with the same token throws "already used".
 * Also asserts the burned args' `tool` matches the token's `tool` (defence in
 * depth against a swapped id).
 */
export async function verifyAndBurnProposal(opts: {
  token: string;
  secret: string;
}): Promise<VerifiedProposal> {
  let raw: Buffer;
  try {
    raw = Buffer.from(opts.token, "base64url");
  } catch {
    throw new InvalidProposalError("Malformed proposal token");
  }
  if (raw.length <= IV_LENGTH + TAG_LENGTH) {
    throw new InvalidProposalError("Malformed proposal token");
  }

  const iv = raw.subarray(0, IV_LENGTH);
  const ciphertext = raw.subarray(IV_LENGTH, raw.length - TAG_LENGTH);
  const tag = raw.subarray(raw.length - TAG_LENGTH);

  let payload: ProposalPayload;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      deriveKey(opts.secret),
      iv,
    );
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf-8");
    payload = JSON.parse(plaintext);
  } catch {
    throw new InvalidProposalError("Bad proposal token");
  }

  if (
    typeof payload.proposalId !== "string" ||
    typeof payload.tool !== "string" ||
    typeof payload.actorEmail !== "string" ||
    typeof payload.exp !== "number"
  ) {
    throw new InvalidProposalError("Invalid proposal payload");
  }
  if (payload.exp < Math.floor(Date.now() / 1000)) {
    throw new InvalidProposalError("Proposal expired");
  }

  // Single-use burn. If Redis is unreachable this throws a retryable error →
  // fail-closed (no write proceeds without a successful burn), but the confirm
  // route can distinguish it (503) from a genuinely spent token (410).
  const redis = getRedis();
  let stored: string | null;
  try {
    stored = (await redis.eval(BURN_LUA, 1, redisKey(payload.proposalId))) as
      | string
      | null;
  } catch {
    throw new InvalidProposalError("Redis unavailable", "redis_unavailable");
  }
  if (!stored) {
    throw new InvalidProposalError("Proposal already used or expired");
  }

  let parsed: { tool: string; args: Record<string, unknown> };
  try {
    parsed = JSON.parse(stored);
  } catch {
    throw new InvalidProposalError("Corrupt proposal args");
  }
  if (parsed.tool !== payload.tool) {
    throw new InvalidProposalError("Proposal tool mismatch");
  }

  return { ...payload, args: parsed.args ?? {} };
}
