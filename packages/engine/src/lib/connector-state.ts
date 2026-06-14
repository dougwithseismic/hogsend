import { createHmac } from "node:crypto";
import { safeEqual } from "../webhook-sources/verify.js";

/**
 * Engine-owned, GENERIC signed connector state — the CSRF/binding token carried
 * on a connector OAuth `state` query param. The connector OAuth callback lands
 * UNAUTHENTICATED (it is a public redirect target), so every connect/authorize
 * URL must carry a server-minted, server-verified `state`:
 *
 *  - `purpose: "install"` — CSRF only (a one-click bot/app install). No contact
 *    is bound; the callback just proves the redirect was initiated by us.
 *  - `purpose: "member_link"` — binds the EXACT contact/email the per-member
 *    link was issued for, so the callback attaches the platform identity to THAT
 *    contact (never to whatever email the platform happens to report — the
 *    grafting/account-takeover vector).
 *
 * The token is `base64url(JSON(payload)).base64url(HMAC-SHA256(payloadB64))`,
 * signed with the engine's `BETTER_AUTH_SECRET`. The same hardened constant-time
 * compare the connector ingress uses ({@link safeEqual}) guards verification.
 *
 * REPLAY: the token is single-use WHEN a nonce store is available — the OAuth
 * callback burns the per-mint `nonce` on first use (a `SET … NX` in Redis), so a
 * captured callback URL cannot be replayed. Without Redis (self-host without it,
 * tests) it degrades to TTL-bounded validity: the signature + `exp` still gate
 * it, but the same token works until expiry. The mint TTL is the replay window.
 */
export interface ConnectorStateIntent {
  purpose: "install" | "member_link";
  connectorId: string;
  /** Member-link only — the bound contact id (authoritative resolution key). */
  contactId?: string;
  /** Member-link only — the bound contact email (authoritative resolution key). */
  email?: string;
  /**
   * High-entropy per-mint value so two states are never byte-identical AND so
   * the callback can burn it for single-use replay protection (see header).
   */
  nonce: string;
}

interface SignedStatePayload extends ConnectorStateIntent {
  /** Absolute expiry, seconds since the unix epoch. */
  exp: number;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(payloadB64: string, secret: string): string {
  return createHmac("sha256", secret).update(payloadB64).digest("base64url");
}

/**
 * Mint a signed connector-state token from an intent. `Date.now()` is fine here
 * — this is engine RUNTIME code (route handlers), not a journey workflow script.
 */
export function signConnectorState(
  intent: ConnectorStateIntent,
  secret: string,
  ttlSeconds: number,
): string {
  const payload: SignedStatePayload = {
    ...intent,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const payloadB64 = base64url(JSON.stringify(payload));
  const sigB64 = sign(payloadB64, secret);
  return `${payloadB64}.${sigB64}`;
}

/**
 * Verify a signed connector-state token. Recomputes the HMAC, constant-time
 * compares it, then enforces expiry. Returns `{ valid: false, reason }` on ANY
 * malformed/bad/expired input — NEVER throws.
 */
export function verifyConnectorState(
  token: string,
  secret: string,
): { valid: boolean; intent?: ConnectorStateIntent; reason?: string } {
  if (typeof token !== "string" || token.length === 0) {
    return { valid: false, reason: "missing_token" };
  }
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) {
    return { valid: false, reason: "malformed_token" };
  }
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);

  const expectedSig = sign(payloadB64, secret);
  if (!safeEqual(sigB64, expectedSig)) {
    return { valid: false, reason: "bad_signature" };
  }

  let payload: SignedStatePayload;
  try {
    payload = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf8"),
    ) as SignedStatePayload;
  } catch {
    return { valid: false, reason: "malformed_payload" };
  }

  if (typeof payload.exp !== "number") {
    return { valid: false, reason: "malformed_payload" };
  }
  if (payload.exp <= Math.floor(Date.now() / 1000)) {
    return { valid: false, reason: "expired" };
  }

  const { exp: _exp, ...intent } = payload;
  return { valid: true, intent };
}
