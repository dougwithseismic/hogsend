import { createPublicKey, verify as edVerify } from "node:crypto";
import { editInteractionResponse } from "./interactions-followup.js";

/**
 * Discord interactions — Ed25519 request verification + the cold-connect
 * link-confirm UX.
 *
 * Discord signs every interaction request over `timestamp || rawBody` with the
 * application's Ed25519 key; the route MUST verify against the EXACT raw bytes
 * (no JSON re-stringify) using the case-insensitive `x-signature-ed25519` /
 * `x-signature-timestamp` headers. We use `node:crypto`'s native Ed25519
 * (`verify("ed25519", ...)`) wrapping the raw 32-byte public key in a SPKI DER
 * prefix — NO `tweetnacl`. Verification FAILS CLOSED: a missing header, a
 * malformed key, or a thrown verify all resolve to `false`.
 *
 * The link-confirm UX is a single private-MODAL step (ephemeral to the invoker;
 * no secret ever rides in a `custom_id`, a rendered message, or a log) followed
 * by a one-click EMAIL link — there is no typed-code path:
 *  A `/link` APPLICATION_COMMAND → open the email modal (type 9).
 *  B email MODAL_SUBMIT          → defer (type 5, flags 64), then out of band
 *                                  `requestConfirm` (mint a cold-connect token +
 *                                  email the one-click confirm LINK) and PATCH
 *                                  @original with a button-less "check your
 *                                  inbox, click the link" message.
 *
 * The bind itself now happens in the BROWSER: the user clicks the emailed link,
 * lands on the engine-served cold-connect page (the CONSUMER mounts
 * `discordColdConnect.routes`), and the page's button POST runs the exchange
 * (fold `discord_id` + email onto one contact, `afterBind` grants the verified
 * role, the page client-identifies). Discord only ever shows "check your inbox".
 *
 * Re B deferral: a modal-open is the INITIAL response and does zero work, so it
 * is instant (within Discord's 3s window). The modal SUBMIT does slow work (a
 * token mint + a provider HTTP send) that can exceed 3s under cold-start /
 * cross-region latency, so it DEFERS first and PATCHes @original out of band (the
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
  /** Open a modal — the INITIAL response to /link's email collection. */
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
} as const;

/** The Text Input `custom_id` read out of the email modal's submit. */
const EMAIL_INPUT_ID = "email";

/** A Discord interaction-response body (what the route 200s back). */
export interface InteractionResponse {
  type: number;
  data?: Record<string, unknown>;
}

/**
 * The confirm-link TTL rendered in the "check your inbox" copy. The plugin
 * cannot read the engine's cold-connect `ttlSeconds` (it lives in the consumer's
 * `discordColdConnect` config closure), so this mirrors the cold-connect default
 * of 900s. Matches the Telegram link-request journey copy, which also hardcodes
 * "15 minutes". Keep this in sync if the consumer overrides `ttlSeconds`.
 */
const CONFIRM_TTL_MINUTES = 15;

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
 * The "check your inbox" PATCH body that replaces the deferred email-submit ack.
 * It carries NO components — the one-click confirm action lives in the EMAILED
 * link (the bind happens in the browser, not via a Discord button). It NEVER
 * echoes the email address — the user just typed it into the modal, and not
 * re-stating it keeps the address out of the rendered message. The "N minutes"
 * mirrors {@link CONFIRM_TTL_MINUTES}.
 */
function checkInboxBody(): Record<string, unknown> {
  return {
    content:
      "Check your inbox for a confirmation link, then click it to finish " +
      `linking. The link expires in ${CONFIRM_TTL_MINUTES} minutes. Didn't ` +
      "get it? Re-run /link and double-check the address.",
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
  const v = readModalValue(payload, EMAIL_INPUT_ID);
  if (typeof v === "string") values[EMAIL_INPUT_ID] = v;
  return { discordUserId, token, modalId, values };
}

/**
 * The result of {@link InteractionDeps.requestConfirm} — mirrors the engine's
 * `MintConfirmResult` shape (throttled / Redis-down both surface as `ok:false`),
 * but `ok:true` carries NO token: the confirm token is server-sealed and only
 * ever lands in the emailed URL the consumer builds, never in this handler.
 */
export type RequestConfirmResult =
  | { ok: true }
  | { ok: false; reason: "rate_limited" | "unavailable" };

/**
 * Dependencies the link-confirm flow runs against. The connector wires these
 * from its config closure so the plugin holds NO engine internals (no db, no
 * Redis, no `process.env`, no email service) — exactly how `resolveContact`/
 * `saveDerived` are injected.
 *
 * There is ONE consumer callback for the front of the flow: `requestConfirm`.
 * The handler never sees the minted token (it is server-sealed and only ever
 * lands in the emailed link), so mint + URL-build + send are one inseparable
 * unit the consumer owns — exactly as the Telegram link-request journey does it
 * (`mintConfirm` → `confirmUrl` → transactional send). The bind, analytics
 * merge, role grant (`afterBind`), and `discord.linked` emit all happen later in
 * `discordColdConnect.routes` when the user clicks the emailed link.
 */
export interface InteractionDeps {
  /** Discord application id — the deferred follow-up PATCH target. */
  applicationId: string;
  /**
   * Mint a server-sealed cold-connect confirm token for `(discordUserId, email)`
   * AND email the one-click confirm LINK to that address. The CONSUMER wires this
   * to `discordColdConnect.mintConfirm({ platformUserId: discordUserId, email })`,
   * builds the URL with `discordColdConnect.confirmUrl(...)`, and sends it via a
   * TRANSACTIONAL mailer (`category:"transactional"`, `skipPreferenceCheck:true`)
   * so a confirm link is NEVER dropped by unsubscribe/frequency suppression.
   *
   * The cold-connect primitive owns the anti-email-bomb throttle (Redis-INCR,
   * fail-closed): an over-cap mint returns `{ ok:false, reason:"rate_limited" }`
   * and a Redis fault `{ ok:false, reason:"unavailable" }` — the consumer MUST
   * NOT send a link on `ok:false`. A thrown error (e.g. mailer down) MUST
   * propagate so the loop fails CLOSED (an apologetic reply, no link).
   */
  requestConfirm: (args: {
    discordUserId: string;
    email: string;
  }) => Promise<RequestConfirmResult>;
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
 * The async work behind the email modal submit (step B): validate → mint a
 * cold-connect confirm token + email the one-click confirm LINK (both inside the
 * consumer-supplied `requestConfirm`) → PATCH the deferred ack into a button-less
 * "check your inbox, click the link" message. Fire-and-forget from
 * `handleInteraction` (the type-5 ack already went back inside the 3s window).
 * NEVER throws to the caller — every failure path edits an apologetic message and
 * logs ONLY a short reason (never the email). No PATCH body echoes the email.
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
      // requestConfirm runs the cold-connect throttle FIRST and only mints +
      // emails the link when under cap. A thrown error here (mailer/Redis down)
      // is caught below → apologetic reply, NO link — an unthrottled send would
      // defeat the email-bomb control.
      const result = await deps.requestConfirm({
        discordUserId: submit.discordUserId,
        email,
      });
      if (!result.ok) {
        // rate_limited vs. unavailable both surface a "try again later" reply;
        // never confirm whether an address exists / was previously linked.
        body = plainTextBody(
          result.reason === "rate_limited"
            ? "You've requested too many confirmation links recently. " +
                "Please try again later."
            : "Linking is briefly unavailable — please try /link again shortly.",
        );
      } else {
        // Success → the button-less "check your inbox" message. The email is NOT
        // echoed (it lived in the modal the user just typed), and the confirm
        // action is the EMAILED link, not a Discord button.
        body = checkInboxBody();
      }
    }
  } catch (err) {
    // Never echo the error (it may carry email/provider detail) — log a short
    // reason only, and NEVER the email.
    deps.logger.error("discord link email follow-up failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    body = plainTextBody(
      "Something went wrong sending your confirmation link. " +
        "Please try /link again.",
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
 * Answer an already-signature-verified interaction (the connector runs the
 * ed25519 verify FIRST and only calls this on success). Routes on `payload.type`
 * first, then the command name (type 2) or the modal `custom_id` (type 5):
 *
 *  - PING(1)                   → PONG(1).
 *  - APPLICATION_COMMAND /link → open the email modal (type 9; zero work, so
 *                                instant within 3s).
 *  - MODAL_SUBMIT email        → DEFER (type-5 ephemeral ack) + out-of-band
 *                                `requestConfirm` (mint cold-connect token + email
 *                                the confirm LINK) + PATCH the button-less "check
 *                                your inbox" message. The bind itself happens in
 *                                the browser when the user clicks that link.
 *
 * There is NO typed-code path (`/verify`, the Enter-code button, the code modal
 * are all gone) — the email-link click is the bind.
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
    // A command we don't serve — deferred ack so Discord doesn't error.
    return {
      type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    };
  }

  // --- type 5: MODAL_SUBMIT -------------------------------------------------
  const submit = parseModalSubmit(payload);
  if (submit) {
    if (submit.modalId === CustomIds.EMAIL_MODAL) {
      // Validate SYNCHRONOUSLY so a bad address gets an INSTANT inline ephemeral
      // error (type 4 — legal for a modal submit; only type-9 modals aren't).
      // This avoids deferring (and thus the racy follow-up edit) for the most
      // common mistake — a typo'd / non-email value. Only a valid address defers
      // into the out-of-band mint+email-link+PATCH (step B).
      const email = normalizeEmail(submit.values[EMAIL_INPUT_ID] ?? "");
      if (!email) {
        return ephemeralReply(
          "That doesn't look like a valid email address — check it and run " +
            "/link to try again.",
        );
      }
      void runEmailFollowUp(submit, email, deps);
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
