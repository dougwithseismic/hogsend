import { createPublicKey, verify as edVerify } from "node:crypto";
import { LINK_CODE_TTL_SECONDS } from "@hogsend/engine";
import { editInteractionResponse } from "./interactions-followup.js";

/**
 * Discord interactions — Ed25519 request verification + the native identify UX.
 *
 * Discord signs every interaction request over `timestamp || rawBody` with the
 * application's Ed25519 key; the route MUST verify against the EXACT raw bytes
 * (no JSON re-stringify) using the case-insensitive `x-signature-ed25519` /
 * `x-signature-timestamp` headers. We use `node:crypto`'s native Ed25519
 * (`verify("ed25519", ...)`) wrapping the raw 32-byte public key in a SPKI DER
 * prefix — NO `tweetnacl`. Verification FAILS CLOSED: a missing header, a
 * malformed key, or a thrown verify all resolve to `false`.
 *
 * The identify UX is a private-MODAL loop (every step is ephemeral to the
 * invoker; no secret ever rides in a `custom_id`, a rendered message, or a log):
 *  A `/link` APPLICATION_COMMAND      → open the email modal (type 9).
 *  B email MODAL_SUBMIT               → defer (type 5, flags 64), then out of
 *                                       band mint+send and PATCH @original with
 *                                       an "Enter code" button.
 *  C "Enter code" MESSAGE_COMPONENT   → open the code modal (type 9). This button
 *                                       is the MANDATORY bridge: Discord forbids
 *                                       returning a modal from a MODAL_SUBMIT, so
 *                                       a component click sits between the two
 *                                       modals.
 *  D code MODAL_SUBMIT                → defer (type 5, flags 64), then out of band
 *                                       redeem+resolve and PATCH @original with a
 *                                       Components-V2 success card (or plain text
 *                                       on failure).
 *  Fallback `/verify <code>` slash    → INLINE ephemeral redeem (kept for clients
 *                                       that can't use the button/modal).
 *
 * Re B/D deferral: a modal-open is the INITIAL response and does zero work, so it
 * is instant (within Discord's 3s window). The modal SUBMITS do slow work (a
 * provider HTTP send; a DB transaction) that can exceed 3s under cold-start /
 * cross-region latency, so they DEFER first and PATCH @original out of band (the
 * interaction token is valid ~15 min).
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
  /** "thinking…" ack — modal submits defer, then PATCH @original out of band. */
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
  /** Open a modal — the INITIAL response to /link and the Enter-code button. */
  MODAL: 9,
} as const;

/** Discord component type ids (the subset we emit). */
export const ComponentType = {
  /** Legacy Action Row (wraps a Text Input / Button). */
  ACTION_ROW: 1,
  /** Button. */
  BUTTON: 2,
  /** Text Input (modal field). */
  TEXT_INPUT: 4,
  /** Text Display (Components V2 — required since V2 disables `content`). */
  TEXT_DISPLAY: 10,
  /** Container (Components V2 — the success-card wrapper). */
  CONTAINER: 17,
  /** Label (modern modal-field wrapper; we ALSO read it on inbound submits). */
  LABEL: 18,
} as const;

/** Discord interaction-response / message flags (the subset we set). */
export const InteractionCallbackFlags = {
  /** 64 — only the invoking user sees the reply. */
  EPHEMERAL: 1 << 6,
  /** 32768 — Components V2 (disables `content`/`embeds`). */
  IS_COMPONENTS_V2: 1 << 15,
} as const;

/** The static `custom_id` step routers — NONE carries a secret/user data. */
export const CustomIds = {
  EMAIL_MODAL: "discord_link_email_modal",
  ENTER_CODE_BUTTON: "discord_link_enter_code",
  CODE_MODAL: "discord_link_code_modal",
} as const;

/** The Text Input `custom_id`s read out of the two modals' submits. */
const EMAIL_INPUT_ID = "email";
const CODE_INPUT_ID = "code";

/** Discord blurple (#5865F2) as a decimal accent_color for the V2 card. */
const BLURPLE_ACCENT = 0x5865f2;

/** A Discord interaction-response body (what the route 200s back). */
export interface InteractionResponse {
  type: number;
  data?: Record<string, unknown>;
}

/**
 * How long a minted code is valid before redeem (15 minutes). Re-exported from
 * the engine so the TTL has a SINGLE source — the copy string below derives its
 * "N minutes" from this same value rather than hard-coding it twice.
 */
export { LINK_CODE_TTL_SECONDS };

/** The TTL rendered in user-facing copy, derived from the single source. */
const TTL_MINUTES = Math.round(LINK_CODE_TTL_SECONDS / 60);

/** Build an EPHEMERAL inline message response (type 4, flags 64). */
export function ephemeralReply(content: string): InteractionResponse {
  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content, flags: InteractionCallbackFlags.EPHEMERAL },
  };
}

/** Build an EPHEMERAL deferred ack (type 5, flags 64) for a modal submit. */
function ephemeralDeferredAck(): InteractionResponse {
  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionCallbackFlags.EPHEMERAL },
  };
}

/**
 * The email-collection modal (the INITIAL response to `/link`). A modal is
 * inherently private to the invoker, so it takes NO `flags`. The single Text
 * Input's `custom_id` ("email") is read at submit; `max_length:254` mirrors the
 * server-side RFC bound (but is client-only — the follow-up re-checks).
 */
function emailModalResponse(): InteractionResponse {
  return {
    type: InteractionResponseType.MODAL,
    data: {
      custom_id: CustomIds.EMAIL_MODAL,
      title: "Link your email",
      components: [
        {
          type: ComponentType.ACTION_ROW,
          components: [
            {
              type: ComponentType.TEXT_INPUT,
              custom_id: EMAIL_INPUT_ID,
              style: 1,
              label: "Email address",
              placeholder: "you@example.com",
              min_length: 3,
              max_length: 254,
              required: true,
            },
          ],
        },
      ],
    },
  };
}

/**
 * The code-collection modal (the response to the Enter-code button click — the
 * legal modal hop the modal→modal prohibition forces us through). `max_length`
 * is generous; the engine redeem trims + bounds the code.
 */
function codeModalResponse(): InteractionResponse {
  return {
    type: InteractionResponseType.MODAL,
    data: {
      custom_id: CustomIds.CODE_MODAL,
      title: "Enter your code",
      components: [
        {
          type: ComponentType.ACTION_ROW,
          components: [
            {
              type: ComponentType.TEXT_INPUT,
              custom_id: CODE_INPUT_ID,
              style: 1,
              label: "6-digit code",
              placeholder: "123456",
              min_length: 1,
              max_length: 12,
              required: true,
            },
          ],
        },
      ],
    },
  };
}

/**
 * The "check your inbox" PATCH body that replaces the deferred email-submit ack.
 * It carries the Enter-code button (the bridge to the code modal) and NEVER
 * echoes the email address — the user just typed it into the modal, and not
 * re-stating it keeps the address out of the rendered message. The "N minutes"
 * is derived from {@link LINK_CODE_TTL_SECONDS}.
 */
function checkInboxBody(): Record<string, unknown> {
  return {
    content:
      "Check your inbox for a 6-digit code, then tap the button below to " +
      `enter it. The code expires in ${TTL_MINUTES} minutes.`,
    components: [
      {
        type: ComponentType.ACTION_ROW,
        components: [
          {
            type: ComponentType.BUTTON,
            style: 1,
            label: "Enter code",
            custom_id: CustomIds.ENTER_CODE_BUTTON,
          },
        ],
      },
    ],
  };
}

/**
 * The Components-V2 ephemeral success card PATCHed in after a successful redeem.
 * V2 (flag 32768) DISABLES `content`/`embeds`, so the text is Text Display
 * components inside a Container; the EPHEMERAL bit (64) PERSISTS — the body
 * carries `flags: 32832` (64 | 32768), NEVER 32768 alone (which would drop
 * ephemerality on the rendered card). The card does NOT print the email.
 */
function successCardBody(): Record<string, unknown> {
  return {
    flags:
      InteractionCallbackFlags.EPHEMERAL |
      InteractionCallbackFlags.IS_COMPONENTS_V2,
    components: [
      {
        type: ComponentType.CONTAINER,
        accent_color: BLURPLE_ACCENT,
        components: [
          { type: ComponentType.TEXT_DISPLAY, content: "**You're all set**" },
          {
            type: ComponentType.TEXT_DISPLAY,
            content: "Your email is now linked to your Discord account.",
          },
        ],
      },
    ],
  };
}

/** A plain ephemeral text edit (failure paths — a simple `content` PATCH). */
function plainTextBody(content: string): Record<string, unknown> {
  return { content };
}

/** RFC5322-lite email shape check — a cheap guard before any mint/send. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function isLikelyEmail(value: string): boolean {
  return EMAIL_RE.test(value);
}

/** The RFC 5321 practical max length for an addr-spec — the authoritative cap. */
const EMAIL_MAX_LENGTH = 254;

/**
 * A minimal shape for any inbound interaction payload. Every incoming type
 * (PING/command/component/modal-submit) carries the invoking user (guild →
 * `member.user.id`, DM → `user.id`) and the per-interaction `token`.
 */
interface InteractionPayload {
  type?: number;
  token?: string;
  data?: {
    name?: string;
    custom_id?: string;
    options?: Array<{ name?: string; value?: unknown }>;
    components?: unknown;
  };
  member?: { user?: { id?: string } };
  user?: { id?: string };
}

/** The invoking Discord user snowflake (guild → member.user, DM → user). */
function readUserId(payload: InteractionPayload): string | undefined {
  return payload.member?.user?.id ?? payload.user?.id;
}

/**
 * The flat, parsed shape of a verified APPLICATION_COMMAND interaction — the
 * invoking user (the identity the code is BOUND to), the interaction token, the
 * lowercased command name, and the string options.
 */
export interface ParsedCommand {
  /** The invoking Discord user snowflake — the identity the code is bound to. */
  discordUserId: string;
  /** The interaction token — authenticates the deferred follow-up. */
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
export function parseCommand(
  payload: InteractionPayload,
): ParsedCommand | null {
  if (payload.type !== InteractionType.APPLICATION_COMMAND) return null;
  const discordUserId = readUserId(payload);
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

/** The parsed shape of a verified MESSAGE_COMPONENT (button click). */
export interface ParsedComponent {
  discordUserId: string;
  /** The interaction token — REQUIRED (authenticates any follow-up). */
  token: string;
  /** The clicked component's static `custom_id`. */
  customId: string;
}

/**
 * Pull the invoking user + token + `custom_id` from a verified type-3 payload.
 * Returns null for any non-component / malformed payload (mirrors parseCommand:
 * a missing user/token/custom_id falls through to the deferred ack).
 */
export function parseComponent(
  payload: InteractionPayload,
): ParsedComponent | null {
  if (payload.type !== InteractionType.MESSAGE_COMPONENT) return null;
  const discordUserId = readUserId(payload);
  const token = payload.token;
  const customId = payload.data?.custom_id;
  if (!discordUserId || !token || !customId) return null;
  return { discordUserId, token, customId };
}

/** The parsed shape of a verified MODAL_SUBMIT. */
export interface ParsedModalSubmit {
  discordUserId: string;
  /** The interaction token — REQUIRED (authenticates the deferred PATCH). */
  token: string;
  /** The submitting modal's static `custom_id` step router. */
  modalId: string;
  /** The submitted input values, keyed by each input's inner `custom_id`. */
  values: Record<string, string>;
}

/**
 * Read a modal input's value by its inner `custom_id`, POSITION-INDEPENDENT and
 * robust to BOTH modal shapes: the legacy Action Row (type 1) wrapping a Text
 * Input (type 4), AND the modern Label (type 18) wrapping a single nested
 * `component`/`components`. Walks the tree, returns the first matching Text
 * Input's string `value`, and NEVER throws on a malformed shape (returns
 * undefined → the handler replies the validation message).
 */
export function readModalValue(
  payload: InteractionPayload,
  inputCustomId: string,
): string | undefined {
  const roots = payload.data?.components;
  if (!Array.isArray(roots)) return undefined;
  // Iterative DFS over the (shallow) component tree; tolerant of either shape.
  const stack: unknown[] = [...roots];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    const n = node as {
      type?: number;
      custom_id?: string;
      value?: unknown;
      component?: unknown;
      components?: unknown;
    };
    if (
      n.type === ComponentType.TEXT_INPUT &&
      n.custom_id === inputCustomId &&
      typeof n.value === "string"
    ) {
      return n.value;
    }
    if (Array.isArray(n.components)) stack.push(...n.components);
    if (n.component) stack.push(n.component);
  }
  return undefined;
}

/**
 * Parse a verified type-5 payload into the invoking user + token + modal id +
 * input values. Returns null when the user, token, or modal `custom_id` is
 * missing (mirrors parseCommand) so callers fall through to the deferred ack.
 */
export function parseModalSubmit(
  payload: InteractionPayload,
): ParsedModalSubmit | null {
  if (payload.type !== InteractionType.MODAL_SUBMIT) return null;
  const discordUserId = readUserId(payload);
  const token = payload.token;
  const modalId = payload.data?.custom_id;
  if (!discordUserId || !token || !modalId) return null;
  const values: Record<string, string> = {};
  for (const id of [EMAIL_INPUT_ID, CODE_INPUT_ID]) {
    const v = readModalValue(payload, id);
    if (typeof v === "string") values[id] = v;
  }
  return { discordUserId, token, modalId, values };
}

/** Result of minting a code (delegates to the engine throttle+store). */
export type LinkMintResult =
  | { ok: true; code: string }
  | { ok: false; reason: "throttled" };

/** Result of redeeming a code (delegates to the engine store). */
export type LinkRedeemResult =
  | { ok: true; email: string }
  | { ok: false; reason: "invalid" | "expired" | "used" | "wrong_user" };

/** Result of recording a verify attempt (anti-guessing throttle). */
export type VerifyAttemptResult = { throttled: boolean };

/**
 * Dependencies the link → verify loop runs against. The connector wires these
 * from its config closure so the plugin holds NO engine internals (no db, no
 * Redis, no `process.env`) — exactly how `resolveContact`/`saveDerived` are
 * injected. `mintCode`/`redeemCode` delegate to the engine's table-backed
 * `createLinkCode`/`redeemLinkCode` (throttle + single-use + identity-binding +
 * TTL live there); `sendLinkCode` emails the minted code via the consumer's
 * transactional mailer.
 */
export interface InteractionDeps {
  /** Discord application id — the deferred follow-up PATCH target. */
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
   * OPTIONAL anti-guessing throttle, checked BEFORE redeem. Caps how many codes
   * one Discord user may try per window so brute-force traffic can't grind the
   * store. BEST-EFFORT, fail-OPEN: a throttle-store outage MUST NOT block a
   * legitimate redeem (the per-mint caps + the redeem identity-binding are the
   * real backstops — see the `/verify`/code-modal throttle catch). When omitted,
   * no per-attempt cap is applied (each redeem is still identity-bound +
   * single-use, so guessing another account's code is impossible).
   */
  recordVerifyAttempt?: (args: {
    discordUserId: string;
  }) => Promise<VerifyAttemptResult>;
  /** The deferred-follow-up editor (PATCH @original); overridable in tests. */
  editResponse?: typeof editInteractionResponse;
  logger: { error: (msg: string, meta?: unknown) => void };
}

/** Normalize + bound-check a typed email; null when it isn't a usable address. */
function normalizeEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  // EMAIL_MAX_LENGTH (254, RFC 5321) is the authoritative cap — the modal's
  // client-side `max_length:254` can be bypassed by a crafted signed payload.
  if (!isLikelyEmail(email) || email.length > EMAIL_MAX_LENGTH) return null;
  return email;
}

/**
 * The async work behind the email modal submit (step B): validate → throttle +
 * mint → email → PATCH the deferred ack into the "check your inbox" message with
 * the Enter-code button. Fire-and-forget from `handleInteraction` (the type-5
 * ack already went back inside the 3s window). NEVER throws to the caller —
 * every failure path edits an apologetic message and logs ONLY a short reason
 * (never the code or the email). No PATCH body echoes the email address.
 */
async function runEmailFollowUp(
  submit: ParsedModalSubmit,
  rawEmail: string,
  deps: InteractionDeps,
): Promise<void> {
  const edit = deps.editResponse ?? editInteractionResponse;
  let body: Record<string, unknown>;
  try {
    const email = normalizeEmail(rawEmail);
    if (!email) {
      body = plainTextBody(
        "That doesn't look like an email address. Run /link to try again.",
      );
    } else {
      // mintCode runs the throttle FIRST and only mints when under cap. A thrown
      // error here (Redis/DB down) is caught below → apologetic reply, NO send —
      // an unthrottled send would defeat the email-bomb control.
      const minted = await deps.mintCode({
        discordUserId: submit.discordUserId,
        email,
      });
      if (!minted.ok) {
        body = plainTextBody(
          "You've requested too many codes recently. Please try again later.",
        );
      } else {
        await deps.sendLinkCode({ email, code: minted.code });
        // Success → the "check your inbox" message + Enter-code button. The
        // email is NOT echoed (it lived in the modal the user just typed).
        body = checkInboxBody();
      }
    }
  } catch (err) {
    // Never echo the error (it may carry email/provider detail) — log a short
    // reason only, and NEVER the code or the email.
    deps.logger.error("discord link email follow-up failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    body = plainTextBody(
      "Something went wrong sending your code. Please try /link again.",
    );
  }
  try {
    await edit({
      applicationId: deps.applicationId,
      token: submit.token,
      body,
    });
  } catch (err) {
    deps.logger.error("discord link email follow-up edit failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * The async work behind the code modal submit (step D): optional throttle
 * (BEST-EFFORT, fail-OPEN) → redeem (single-use + TTL + identity-bound) →
 * resolve → PATCH the deferred ack into the Components-V2 success card (or a
 * plain text edit on failure). Fire-and-forget; NEVER throws; logs ONLY a short
 * reason. No PATCH body echoes the email.
 */
async function runCodeFollowUp(
  submit: ParsedModalSubmit,
  rawCode: string,
  deps: InteractionDeps,
): Promise<void> {
  const edit = deps.editResponse ?? editInteractionResponse;
  const body = await resolveCodeBody(submit, rawCode, deps);
  try {
    await edit({
      applicationId: deps.applicationId,
      token: submit.token,
      body,
    });
  } catch (err) {
    deps.logger.error("discord link code follow-up edit failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Resolve the code modal submit to a PATCH body (success card or plain text),
 * sharing the redeem + resolve flow with the `/verify` slash fallback's reply.
 */
async function resolveCodeBody(
  submit: ParsedModalSubmit,
  rawCode: string,
  deps: InteractionDeps,
): Promise<Record<string, unknown>> {
  const code = rawCode.trim();
  if (!code) {
    return plainTextBody(
      "That code is invalid, expired, or already used. Run /link for a new one.",
    );
  }
  // Anti-guessing throttle BEFORE redeem (blunts brute-force traffic). BEST-
  // EFFORT, fail-OPEN: a throttle-store outage LOGS and CONTINUES — the per-mint
  // caps + the redeem identity-binding are the real backstops, so a missed
  // throttle never enables cross-account guessing.
  if (deps.recordVerifyAttempt) {
    try {
      const attempt = await deps.recordVerifyAttempt({
        discordUserId: submit.discordUserId,
      });
      if (attempt.throttled) {
        return plainTextBody(
          "Too many verification attempts. Please wait a bit and try again.",
        );
      }
    } catch (err) {
      deps.logger.error("discord link verify throttle failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      // fall through to redeem (fail-open).
    }
  }
  let result: LinkRedeemResult;
  try {
    result = await deps.redeemCode({
      discordUserId: submit.discordUserId,
      code,
    });
  } catch (err) {
    deps.logger.error("discord link verify redeem failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return plainTextBody(
      "Something went wrong verifying your code. Please try again.",
    );
  }
  if (!result.ok) {
    // Collapse invalid/expired/used/wrong_user into one non-leaking message:
    // never confirm a code exists for another account.
    return plainTextBody(
      "That code is invalid, expired, or already used. Run /link for a new one.",
    );
  }
  try {
    await deps.resolveContact({
      discordId: submit.discordUserId,
      email: result.email,
    });
  } catch (err) {
    deps.logger.error("discord link verify resolveContact failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return plainTextBody(
      "We verified your code but couldn't finish linking. Please try again.",
    );
  }
  // Success → the Components-V2 card. The email is NOT printed (it is the user's
  // own address, typed two steps earlier — keep it out of the rendered card).
  return successCardBody();
}

/**
 * Answer an already-signature-verified interaction (the connector runs the
 * ed25519 verify FIRST and only calls this on success). Routes on `payload.type`
 * first, then the command name (type 2) or the static `custom_id` (types 3/5):
 *
 *  - PING(1)                          → PONG(1).
 *  - APPLICATION_COMMAND /link        → open the email modal (type 9; zero work,
 *                                       so instant within 3s).
 *  - APPLICATION_COMMAND /verify <code> → INLINE ephemeral redeem (the slash
 *                                       fallback; no deferral — DB-bounded work).
 *  - MESSAGE_COMPONENT Enter-code     → open the code modal (type 9; the legal
 *                                       hop the modal→modal ban forces).
 *  - MODAL_SUBMIT email               → DEFER (type-5 ephemeral ack) + out-of-band
 *                                       mint+send+PATCH (the send is a provider
 *                                       HTTP call that can exceed 3s).
 *  - MODAL_SUBMIT code                → DEFER + out-of-band redeem+resolve+PATCH.
 *
 * Without `deps` (PING/PONG-only callers) OR for a payload we don't serve,
 * returns the historical deferred ack so Discord doesn't error.
 */
export async function handleInteraction(
  payload: InteractionPayload,
  deps?: InteractionDeps,
): Promise<InteractionResponse> {
  if (payload.type === InteractionType.PING) {
    return { type: InteractionResponseType.PONG };
  }

  // No deps → historical deferred ack (preserves PING/PONG-only callers).
  if (!deps) {
    return {
      type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    };
  }

  // --- type 2: APPLICATION_COMMAND -----------------------------------------
  const command = parseCommand(payload);
  if (command) {
    if (command.name === "link") {
      // Step A — open the email modal. A modal IS the initial response and does
      // zero work, so it is instant (no deferral needed).
      return emailModalResponse();
    }
    if (command.name === "verify") {
      // Fallback slash path — INLINE ephemeral redeem (kept for clients that
      // can't use the button/modal). DB-bounded, so no deferral.
      const body = await resolveCodeBody(
        {
          discordUserId: command.discordUserId,
          token: command.token,
          modalId: "verify",
          values: {},
        },
        command.options.code ?? "",
        deps,
      );
      // resolveCodeBody returns either a plain `{ content }` (failure) or the
      // V2 success card. For the inline /verify reply, render the success as a
      // simple ephemeral text (the slash path predates V2 cards).
      if (typeof body.content === "string") {
        return ephemeralReply(body.content);
      }
      return ephemeralReply(
        "Linked your email to your Discord account. You're all set.",
      );
    }
    // A command we don't serve — deferred ack so Discord doesn't error.
    return {
      type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    };
  }

  // --- type 3: MESSAGE_COMPONENT (the Enter-code bridge button) -------------
  const component = parseComponent(payload);
  if (component) {
    if (component.customId === CustomIds.ENTER_CODE_BUTTON) {
      // Step C — open the code modal (legal from a component; the modal→modal
      // ban is why a button sits between the two modals).
      return codeModalResponse();
    }
    return {
      type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    };
  }

  // --- type 5: MODAL_SUBMIT -------------------------------------------------
  const submit = parseModalSubmit(payload);
  if (submit) {
    if (submit.modalId === CustomIds.EMAIL_MODAL) {
      // Step B — DEFER first (inside 3s), then mint+send+PATCH out of band.
      void runEmailFollowUp(submit, submit.values[EMAIL_INPUT_ID] ?? "", deps);
      return ephemeralDeferredAck();
    }
    if (submit.modalId === CustomIds.CODE_MODAL) {
      // Step D — DEFER first, then redeem+resolve+PATCH out of band.
      void runCodeFollowUp(submit, submit.values[CODE_INPUT_ID] ?? "", deps);
      return ephemeralDeferredAck();
    }
    return {
      type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    };
  }

  // Anything else (autocomplete, an unparseable payload) — deferred ack.
  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
  };
}
