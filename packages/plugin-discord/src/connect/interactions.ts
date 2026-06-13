import { createPublicKey, verify as edVerify } from "node:crypto";

/**
 * Discord interactions — Ed25519 request verification + the PING/PONG handshake.
 *
 * Discord signs every interaction request over `timestamp || rawBody` with the
 * application's Ed25519 key; the route MUST verify against the EXACT raw bytes
 * (no JSON re-stringify) using the case-insensitive `x-signature-ed25519` /
 * `x-signature-timestamp` headers. We use `node:crypto`'s native Ed25519
 * (`verify("ed25519", ...)`) wrapping the raw 32-byte public key in a SPKI DER
 * prefix — NO `tweetnacl`. Verification FAILS CLOSED: a missing header, a
 * malformed key, or a thrown verify all resolve to `false`.
 */

// SPKI DER prefix for an Ed25519 public key (RFC 8410): the fixed 12-byte
// AlgorithmIdentifier + BIT STRING header preceding the raw 32-byte key.
const ED25519_SPKI_PREFIX = Buffer.from([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);

// Reject interaction requests whose `x-signature-timestamp` is more than this
// many seconds from now (in either direction) — a replay window. Discord signs
// `timestamp || rawBody`, so a captured-and-replayed request still verifies
// cryptographically; the timestamp bound caps how long such a capture stays
// usable.
const INTERACTION_REPLAY_WINDOW_SECONDS = 300;

function rawEd25519KeyToSpki(publicKeyHex: string) {
  const raw = Buffer.from(publicKeyHex, "hex");
  if (raw.length !== 32) {
    throw new Error(
      `invalid Discord public key: expected 32 bytes, got ${raw.length}`,
    );
  }
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

export interface VerifyInteractionSignatureArgs {
  /** The application's Ed25519 public key, hex (Developer Portal → General). */
  publicKeyHex: string;
  /** `x-signature-ed25519` header value (hex). */
  signatureHex: string;
  /** `x-signature-timestamp` header value. */
  timestamp: string;
  /** EXACT raw request body bytes (the route's `c.req.text()`). */
  rawBody: string;
}

/**
 * Verify a Discord interaction request. Returns `false` (fail closed) on ANY
 * problem — absent signature/timestamp, bad key, or a verify throw. Discord
 * signs `timestamp || rawBody`, so we concat in THAT order.
 */
export function verifyInteractionSignature(
  args: VerifyInteractionSignatureArgs,
): boolean {
  const { publicKeyHex, signatureHex, timestamp, rawBody } = args;
  if (!publicKeyHex || !signatureHex || !timestamp) return false;

  // Replay-window check BEFORE the (relatively expensive) ed25519 verify: a
  // non-numeric or stale/future timestamp is rejected outright. The timestamp
  // is covered by the signature, so an attacker cannot edit it post-capture
  // without breaking the signature.
  const ts = Number(timestamp);
  if (
    !Number.isFinite(ts) ||
    Math.abs(Math.floor(Date.now() / 1000) - ts) >
      INTERACTION_REPLAY_WINDOW_SECONDS
  ) {
    return false;
  }

  let signature: Buffer;
  try {
    signature = Buffer.from(signatureHex, "hex");
  } catch {
    return false;
  }
  if (signature.length !== 64) return false;

  try {
    const key = rawEd25519KeyToSpki(publicKeyHex);
    const message = Buffer.concat([
      Buffer.from(timestamp),
      Buffer.from(rawBody),
    ]);
    return edVerify(null, message, key, signature);
  } catch {
    return false;
  }
}

/** Discord interaction type ids (the subset we branch on). */
export const InteractionType = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
  APPLICATION_COMMAND_AUTOCOMPLETE: 4,
  MODAL_SUBMIT: 5,
} as const;

/** Discord interaction-response type ids (the subset we emit). */
export const InteractionResponseType = {
  PONG: 1,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
} as const;

/** A Discord interaction-response body (what the route 200s back). */
export interface InteractionResponse {
  type: number;
  data?: Record<string, unknown>;
}

/**
 * Answer an already-signature-verified interaction. PING(1) → PONG(1); every
 * other type gets a deferred ack (Discord shows "thinking…" and expects a
 * follow-up). The caller (the connector's `handlers.interactions`) returns the
 * PONG verbatim for type 1, and a deferred ack otherwise.
 *
 * TODO(discord-gateway): route non-PING interactions (slash commands /
 * components) to a registered handler instead of a bare deferred ack.
 */
export function handleInteraction(payload: {
  type?: number;
}): InteractionResponse {
  if (payload.type === InteractionType.PING) {
    return { type: InteractionResponseType.PONG };
  }
  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
  };
}
