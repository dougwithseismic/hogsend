import { createPublicKey, verify as edVerify } from "node:crypto";
import { editInteractionResponse } from "./interactions-followup.js";

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
  /** Immediate visible reply (used with EPHEMERAL flags for the loop). */
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  /** "thinking…" ack — `/link` defers, then PATCHes @original out of band. */
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
} as const;

/** Discord interaction-response message flags (the subset we set). */
export const InteractionCallbackFlags = {
  /** 64 — only the invoking user sees the reply. */
  EPHEMERAL: 1 << 6,
} as const;

/** A Discord interaction-response body (what the route 200s back). */
export interface InteractionResponse {
  type: number;
  data?: Record<string, unknown>;
}

/** How long a `/link`-minted code is valid before `/verify` (15 minutes). */
export const LINK_CODE_TTL_SECONDS = 900;

/** Build an EPHEMERAL inline message response (type 4, flags 64). */
export function ephemeralReply(content: string): InteractionResponse {
  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content, flags: InteractionCallbackFlags.EPHEMERAL },
  };
}

/** Build an EPHEMERAL deferred ack (type 5, flags 64) for `/link`. */
function ephemeralDeferredAck(): InteractionResponse {
  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionCallbackFlags.EPHEMERAL },
  };
}

/** RFC5322-lite email shape check — a cheap guard before any mint/send. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function isLikelyEmail(value: string): boolean {
  return EMAIL_RE.test(value);
}

/**
 * The flat, parsed shape of a verified APPLICATION_COMMAND interaction — the
 * invoking user (the identity the code is BOUND to), the interaction token (the
 * deferred-follow-up credential for `/link`), the lowercased command name, and
 * the string options.
 */
export interface ParsedCommand {
  /** The invoking Discord user snowflake — the identity the code is bound to. */
  discordUserId: string;
  /** The interaction token — authenticates the deferred `/link` follow-up. */
  token: string;
  /** Lowercased command name. */
  name: string;
  /** Flat string options keyed by option name. */
  options: Record<string, string>;
}

/**
 * Pull the invoking user + token + command name + string options from a verified
 * type-2 payload. Guild commands carry the user under `member.user`; DM commands
 * under `user`. Returns null for any non-command / malformed payload (PING, a
 * payload missing `data.name`, etc.) so callers fall through to the deferred ack.
 */
export function parseCommand(payload: {
  type?: number;
  token?: string;
  data?: { name?: string; options?: Array<{ name?: string; value?: unknown }> };
  member?: { user?: { id?: string } };
  user?: { id?: string };
}): ParsedCommand | null {
  if (payload.type !== InteractionType.APPLICATION_COMMAND) return null;
  const discordUserId = payload.member?.user?.id ?? payload.user?.id;
  const name = payload.data?.name;
  const token = payload.token;
  if (!discordUserId || !name || !token) return null;
  const options: Record<string, string> = {};
  for (const opt of payload.data?.options ?? []) {
    if (opt.name && typeof opt.value === "string") {
      options[opt.name] = opt.value;
    }
  }
  return { discordUserId, token, name: name.toLowerCase(), options };
}

/** Result of minting a `/link` code (delegates to the engine throttle+store). */
export type LinkMintResult =
  | { ok: true; code: string }
  | { ok: false; reason: "throttled" };

/** Result of redeeming a `/verify` code (delegates to the engine store). */
export type LinkRedeemResult =
  | { ok: true; email: string }
  | { ok: false; reason: "invalid" | "expired" | "used" | "wrong_user" };

/** Result of recording a `/verify` attempt (anti-guessing throttle). */
export type VerifyAttemptResult = { throttled: boolean };

/**
 * Dependencies the `/link`→`/verify` loop runs against. The connector wires
 * these from its config closure so the plugin holds NO engine internals (no db,
 * no Redis, no `process.env`) — exactly how `resolveContact`/`saveDerived` are
 * injected. `mintCode`/`redeemCode` delegate to the engine's table-backed
 * `createLinkCode`/`redeemLinkCode` (throttle + single-use + identity-binding +
 * TTL live there); `sendLinkCode` emails the minted code via the consumer's
 * transactional mailer.
 */
export interface InteractionDeps {
  /** Discord application id — the deferred `/link` follow-up PATCH target. */
  applicationId: string;
  /**
   * Mint a single-use code for `(discordUserId, email)`. The engine enforces the
   * anti-email-bomb throttle BEFORE minting and returns `{ ok:false }` when over
   * cap (no code minted, nothing to send). A thrown error (e.g. DB down) MUST
   * propagate so the caller fails CLOSED — never fall through to an unthrottled
   * send.
   */
  mintCode: (args: {
    discordUserId: string;
    email: string;
  }) => Promise<LinkMintResult>;
  /** Email the minted code to the target address (transactional, bypasses prefs). */
  sendLinkCode: (args: { email: string; code: string }) => Promise<void>;
  /**
   * Redeem a typed code for the bound email — single-use, TTL-enforced, and
   * identity-bound to `discordUserId` (the engine re-checks the binding).
   */
  redeemCode: (args: {
    discordUserId: string;
    code: string;
  }) => Promise<LinkRedeemResult>;
  /** Attach the verified email to the Discord identity (resolveOrCreateContact). */
  resolveContact: (args: { discordId: string; email: string }) => Promise<void>;
  /**
   * OPTIONAL anti-guessing throttle for `/verify`, checked BEFORE redeem. Caps
   * how many codes one Discord user may try per window so brute-force `/verify`
   * traffic can't grind the store. When omitted, no per-attempt cap is applied
   * (each redeem is still identity-bound + single-use, so guessing another
   * account's code is impossible — this only blunts CPU/store abuse).
   */
  recordVerifyAttempt?: (args: {
    discordUserId: string;
  }) => Promise<VerifyAttemptResult>;
  /** The deferred-follow-up editor (PATCH @original); overridable in tests. */
  editResponse?: typeof editInteractionResponse;
  logger: { error: (msg: string, meta?: unknown) => void };
}

/**
 * The async work behind a deferred `/link`: throttle+mint → email → PATCH the
 * deferred ack into the final ephemeral reply. Fire-and-forget from
 * `handleInteraction` (the type-5 ack already went back inside the 3s window).
 * NEVER throws to the caller — every failure path edits an apologetic message
 * and logs ONLY a short reason (never the code or the email).
 */
async function runLinkFollowUp(
  command: ParsedCommand,
  email: string,
  deps: InteractionDeps,
): Promise<void> {
  const edit = deps.editResponse ?? editInteractionResponse;
  let content: string;
  try {
    // mintCode runs the throttle FIRST and only mints when under cap. A thrown
    // error here (Redis/DB down) is caught below → apologetic reply, NO send —
    // an unthrottled send would defeat the email-bomb control.
    const minted = await deps.mintCode({
      discordUserId: command.discordUserId,
      email,
    });
    if (!minted.ok) {
      content =
        "You've requested too many codes recently. Please try again later.";
    } else {
      await deps.sendLinkCode({ email, code: minted.code });
      content =
        `Check your inbox at **${email}** for a 6-digit code, then run ` +
        "`/verify <code>` here. The code expires in 15 minutes.";
    }
  } catch (err) {
    // Never echo the error (it may carry email/provider detail) — log a short
    // reason only, and NEVER the code or the email.
    deps.logger.error("discord /link failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    content =
      "Something went wrong sending your code. Please try `/link` again.";
  }
  try {
    await edit({
      applicationId: deps.applicationId,
      token: command.token,
      content,
    });
  } catch (err) {
    deps.logger.error("discord /link follow-up edit failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Answer an already-signature-verified interaction (the connector runs the
 * ed25519 verify FIRST and only calls this on success). PING(1) → PONG(1).
 *
 * With `deps`, APPLICATION_COMMAND(2) interactions route the native identify
 * loop:
 *  - `/link <email>` — validate the email, then DEFER (type-5 ephemeral ack,
 *    inside Discord's 3s window) and out-of-band throttle+mint+email+PATCH the
 *    final reply. Deferring is mandatory: the send path is a provider HTTP call
 *    that can exceed 3s under cold-start / cross-region latency, which would
 *    invalidate the interaction token ("application did not respond").
 *  - `/verify <code>` — INLINE (DB-bounded, no external HTTP): optional attempt
 *    throttle → redeem (single-use + TTL + identity-bound) → attach the email →
 *    ephemeral reply.
 *
 * Without `deps` (PING/PONG-only callers) OR for a payload that isn't a command
 * we serve, returns the historical deferred ack so Discord doesn't error.
 */
export async function handleInteraction(
  payload: {
    type?: number;
    token?: string;
    data?: {
      name?: string;
      options?: Array<{ name?: string; value?: unknown }>;
    };
    member?: { user?: { id?: string } };
    user?: { id?: string };
  },
  deps?: InteractionDeps,
): Promise<InteractionResponse> {
  if (payload.type === InteractionType.PING) {
    return { type: InteractionResponseType.PONG };
  }

  const command = parseCommand(payload);
  // No deps OR not a parseable command → historical deferred ack (preserves
  // PING/PONG-only callers and the "defers any non-PING" contract).
  if (!deps || !command) {
    return {
      type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    };
  }

  if (command.name === "link") {
    const email = (command.options.email ?? "").trim().toLowerCase();
    if (!isLikelyEmail(email)) {
      return ephemeralReply(
        "That doesn't look like an email address. Try " +
          "`/link you@example.com`.",
      );
    }
    // DEFER first (inside the 3s window), then do the slow work out of band.
    void runLinkFollowUp(command, email, deps);
    return ephemeralDeferredAck();
  }

  if (command.name === "verify") {
    const code = (command.options.code ?? "").trim();
    if (!code) {
      return ephemeralReply(
        "Usage: `/verify <code>` — the code we emailed you.",
      );
    }
    // Anti-guessing throttle BEFORE redeem (blunts brute-force /verify traffic).
    if (deps.recordVerifyAttempt) {
      let attempt: VerifyAttemptResult;
      try {
        attempt = await deps.recordVerifyAttempt({
          discordUserId: command.discordUserId,
        });
      } catch (err) {
        // Fail CLOSED: a throttle-store outage rejects rather than allowing
        // unbounded guessing.
        deps.logger.error("discord /verify throttle failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        return ephemeralReply(
          "Something went wrong verifying your code. Please try again.",
        );
      }
      if (attempt.throttled) {
        return ephemeralReply(
          "Too many verification attempts. Please wait a bit and try again.",
        );
      }
    }
    let result: LinkRedeemResult;
    try {
      result = await deps.redeemCode({
        discordUserId: command.discordUserId,
        code,
      });
    } catch (err) {
      deps.logger.error("discord /verify redeem failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return ephemeralReply(
        "Something went wrong verifying your code. Please try again.",
      );
    }
    if (!result.ok) {
      // Collapse invalid/expired/used/wrong_user into one non-leaking message:
      // never confirm a code exists for another account.
      return ephemeralReply(
        "That code is invalid, expired, or already used. Run `/link <email>` " +
          "for a new one.",
      );
    }
    try {
      await deps.resolveContact({
        discordId: command.discordUserId,
        email: result.email,
      });
    } catch (err) {
      deps.logger.error("discord /verify resolveContact failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return ephemeralReply(
        "We verified your code but couldn't finish linking. Please try again.",
      );
    }
    return ephemeralReply(
      `Linked **${result.email}** to your Discord account. You're all set.`,
    );
  }

  // A command we don't serve — deferred ack so Discord doesn't error.
  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
  };
}
