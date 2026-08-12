import type { DomainsCapability } from "./domains.js";

// ---------------------------------------------------------------------------
// Send options (HTML-only wire — NO React)
// ---------------------------------------------------------------------------

/**
 * The provider send wire. HTML-ONLY: the engine ALWAYS renders React → HTML
 * itself (via `@hogsend/email` `renderToHtml`) before calling `send`, so no
 * React ever crosses the provider boundary. React Email stays first-class for
 * template authoring + Studio preview — only this wire is HTML.
 */
export interface SendEmailOptions {
  from: string;
  to: string | string[];
  subject: string;
  /** REQUIRED — the engine always renders React → HTML before the wire. */
  html: string;
  /** Optional plain-text alternative. */
  text?: string;
  replyTo?: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  /**
   * Neutral `{name,value}[]` tags. Each provider maps them natively: Resend
   * passes them straight through; Postmark takes the first tag's value as `Tag`
   * and all of them as `Metadata`; SES emits identical `MessageTag[]`.
   */
  tags?: Array<{ name: string; value: string }>;
  headers?: Record<string, string>;
  /**
   * Neutral attachments; each provider translates onto its own wire (SES
   * structured `Attachments`, Resend/Postmark native fields — nobody writes
   * MIME). Validate with {@link assertValidAttachments} before the wire, and
   * only send them to a provider declaring `capabilities.attachments`.
   */
  attachments?: EmailAttachment[];
  /** Honored only when `capabilities.scheduledSend`; else logged + ignored. */
  scheduledAt?: string;
}

/**
 * A single batch item — the send wire minus the per-message `scheduledAt`.
 * `attachments` is deliberately INHERITED: every provider's `sendBatch` is (or
 * wraps) a loop over single sends, so attachments flow through batch the
 * moment single-send carries them, with no batch-specific shape to drift.
 */
export type BatchEmailItem = Omit<SendEmailOptions, "scheduledAt">;

export interface SendResult {
  id: string;
}

// ---------------------------------------------------------------------------
// Attachments (neutral shape, published limits, shared validation)
// ---------------------------------------------------------------------------

/**
 * The provider-neutral attachment. Content is bytes we never execute and
 * never parse — no thumbnailing, no preview, no archive inspection. Size,
 * filename shape, and count ({@link assertValidAttachments}) are the ONLY
 * things this layer looks at.
 */
export interface EmailAttachment {
  /** Shown to the recipient. Max {@link ATTACHMENT_FILENAME_MAX}; no CR/LF/NUL. */
  filename: string;
  /**
   * The file's content. Raw bytes (`Uint8Array`) are the bare common case;
   * already-base64 content must be DECLARED via the `{ base64 }` wrapper,
   * never handed over as a bare string. That asymmetry is deliberate: the AWS
   * SDK base64-encodes `RawContent` itself, so a base64 string mistaken for
   * raw content gets encoded AGAIN and produces a corrupt file that still
   * sends successfully — nothing errors at any layer; the recipient just gets
   * a broken PDF. No heuristic can catch it either: a base64 string is
   * indistinguishable from a text file whose contents happen to be base64. So
   * the caller declares which one they hold, and the friction sits on the
   * dangerous path.
   */
  content: Uint8Array | { base64: string };
  /**
   * Omit to let the provider default — never guessed from the filename here.
   * Max {@link ATTACHMENT_CONTENT_TYPE_MAX} chars.
   */
  contentType?: string;
  /** `inline` embeds into the HTML via {@link contentId}; default `attachment`. */
  disposition?: "attachment" | "inline";
  /**
   * References an `inline` attachment from the HTML (`cid:` URL). Max
   * {@link ATTACHMENT_CONTENT_ID_MAX} chars; must be non-empty when present.
   */
  contentId?: string;
}

/** SES `FileName` constraint (SESv2 `Attachment` API reference): max 255. */
export const ATTACHMENT_FILENAME_MAX = 255;

/**
 * SES `ContentType` constraint: 1–78 characters. Genuinely 78, not a typo —
 * the kind of cap that is invisible until a `multipart/…; boundary=…`-shaped
 * value hits it, so we reject it here rather than letting SES 400 at the wire.
 */
export const ATTACHMENT_CONTENT_TYPE_MAX = 78;

/** SES `ContentId` constraint: 1–78 characters. */
export const ATTACHMENT_CONTENT_ID_MAX = 78;

/**
 * Per-message attachment count cap. SES's real quota is 500 MIME parts per
 * message, but nothing sane sends hundreds of files — a cheap explicit cap
 * here beats discovering the quota at the wire.
 */
export const MAX_ATTACHMENT_COUNT = 20;

/**
 * Total RAW bytes across ALL attachments on one message.
 *
 * Two different numbers are in play and confusing them is the failure mode:
 * SES v2's ceiling is 40 MB AFTER base64 encoding (the v1 API's ceiling is
 * 10 MB — we are on v2; do not copy the v1 figure out of a blog post). Base64
 * inflates by 4/3, so 25 MiB of raw attachment bytes encodes to ~33.3 MB,
 * leaving comfortable headroom for the HTML body, the text alternative and
 * headers inside SES's 40 MB. We enforce on RAW bytes because that is the
 * number a customer can check on their own file.
 *
 * Honest caveat: many receiving mail servers cap the whole message around
 * 25 MB, so a large attachment can be accepted by SES and still refused
 * downstream. This limit is what we can enforce, not a delivery guarantee.
 */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/**
 * Thrown by {@link assertValidAttachments}. Shared by the relay (400 before
 * SES ever sees the message) and the engine mailer (throw before a send) so
 * both give IDENTICAL answers; `code` lets callers map it to a status without
 * string-matching the message.
 */
export class InvalidAttachmentError extends Error {
  readonly code = "invalid_attachment";
  constructor(message: string) {
    super(message);
    this.name = "InvalidAttachmentError";
  }
}

/**
 * Raw (pre-base64) byte length of one attachment's content. For `{ base64 }`
 * this is the DECODED length computed from the string — a base64 string is
 * 4/3 the size of what it represents, and counting the encoded length instead
 * would make the byte cap wrong by a third in the permissive direction.
 * Handles `=` padding, unpadded strings, and MIME-style line wrapping
 * (whitespace is not content).
 */
export function attachmentByteLength(attachment: EmailAttachment): number {
  const { content } = attachment;
  if (content instanceof Uint8Array) return content.byteLength;
  const b64 = content.base64.replace(/\s+/g, "");
  let padding = 0;
  if (b64.endsWith("==")) padding = 2;
  else if (b64.endsWith("=")) padding = 1;
  return Math.floor((b64.length * 3) / 4) - padding;
}

/**
 * One-decimal MiB rendering for the size error. Two nine-digit byte counts
 * differing in the last digit are unreadable at the moment someone needs them
 * — the MiB form answers "1 byte over or 10 MB over?" at a glance, while the
 * exact counts stay in the message for machines (and tests) to parse.
 */
function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/** CR/LF/NUL — string checks, not a regex, so no control chars in a pattern. */
function hasForbiddenControlChars(value: string): boolean {
  return (
    value.includes("\r") || value.includes("\n") || value.includes("\u0000")
  );
}

/**
 * Names the offender for error messages: by filename where it has a printable
 * one, else by index — an operator reading a 400 needs to know WHICH file.
 */
function describeAttachment(
  attachment: EmailAttachment,
  index: number,
): string {
  const name =
    typeof attachment.filename === "string" ? attachment.filename.trim() : "";
  if (name.length === 0 || hasForbiddenControlChars(name)) {
    return `attachment ${index}`;
  }
  const shown = name.length > 60 ? `${name.slice(0, 57)}…` : name;
  return `attachment ${index} ("${shown}")`;
}

/**
 * Throws {@link InvalidAttachmentError} on the FIRST problem, naming the
 * offending attachment and — for the size cap — both the limit and the actual
 * total, because "too big" without numbers is not actionable.
 *
 * On CR/LF/NUL: SES assembles the MIME itself now, so we cannot inject a
 * header even in principle — this is NOT the classic header-injection fix. We
 * reject them anyway because it costs three lines, and "the layer below
 * probably sanitizes this" is not a control: Resend and Postmark are separate
 * implementations with their own assembly, and this contract is the one thing
 * all three share.
 *
 * Deliberately NO blocked-extension list: SES publishes and enforces its own,
 * and it moves. A vendored copy goes stale in the direction that hurts most —
 * refusing a file SES would have accepted. Let SES refuse, and surface its
 * refusal verbatim (that is `email.rejected`'s job).
 */
export function assertValidAttachments(attachments: EmailAttachment[]): void {
  if (attachments.length > MAX_ATTACHMENT_COUNT) {
    throw new InvalidAttachmentError(
      `Too many attachments: ${attachments.length} (limit ${MAX_ATTACHMENT_COUNT})`,
    );
  }
  let totalBytes = 0;
  for (const [index, attachment] of attachments.entries()) {
    const label = describeAttachment(attachment, index);
    const { filename, contentType, contentId } = attachment;
    // A JS consumer with no compiler reaches this validator too, so a missing
    // or non-string field is ordinary input, not a contrived one. It must be
    // THEIR error (the relay maps `code` to a 400), never our TypeError — a
    // raw TypeError escapes as a 500 and tells the customer WE broke.
    if (typeof filename !== "string" || filename.trim().length === 0) {
      throw new InvalidAttachmentError(
        `${label} has a missing or empty filename`,
      );
    }
    if (hasForbiddenControlChars(filename)) {
      throw new InvalidAttachmentError(
        `${label} filename contains CR, LF or NUL`,
      );
    }
    if (filename.length > ATTACHMENT_FILENAME_MAX) {
      throw new InvalidAttachmentError(
        `${label} filename is ${filename.length} characters (limit ${ATTACHMENT_FILENAME_MAX})`,
      );
    }
    if (contentType !== undefined) {
      if (typeof contentType !== "string") {
        throw new InvalidAttachmentError(
          `${label} contentType must be a string`,
        );
      }
      if (hasForbiddenControlChars(contentType)) {
        throw new InvalidAttachmentError(
          `${label} contentType contains CR, LF or NUL`,
        );
      }
      if (contentType.length > ATTACHMENT_CONTENT_TYPE_MAX) {
        throw new InvalidAttachmentError(
          `${label} contentType is ${contentType.length} characters (limit ${ATTACHMENT_CONTENT_TYPE_MAX})`,
        );
      }
    }
    if (contentId !== undefined) {
      if (typeof contentId !== "string") {
        throw new InvalidAttachmentError(`${label} contentId must be a string`);
      }
      if (contentId.length === 0) {
        throw new InvalidAttachmentError(`${label} has an empty contentId`);
      }
      if (hasForbiddenControlChars(contentId)) {
        throw new InvalidAttachmentError(
          `${label} contentId contains CR, LF or NUL`,
        );
      }
      if (contentId.length > ATTACHMENT_CONTENT_ID_MAX) {
        throw new InvalidAttachmentError(
          `${label} contentId is ${contentId.length} characters (limit ${ATTACHMENT_CONTENT_ID_MAX})`,
        );
      }
    }
    totalBytes += attachmentByteLength(attachment);
  }
  if (totalBytes > MAX_ATTACHMENT_BYTES) {
    throw new InvalidAttachmentError(
      `Attachments total ${formatMiB(totalBytes)} (${totalBytes} raw bytes), over the ${formatMiB(MAX_ATTACHMENT_BYTES)} limit (${MAX_ATTACHMENT_BYTES} bytes)`,
    );
  }
}

// ---------------------------------------------------------------------------
// Recipient normalization (shared by every provider's send wire)
// ---------------------------------------------------------------------------

/** Normalize a `string | string[] | undefined` recipient field to a string[]. */
export function normalizeRecipients(v?: string | string[]): string[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

/** Join a recipient field into a single comma-separated string (Postmark wire). */
export function joinRecipients(v?: string | string[]): string {
  return normalizeRecipients(v).join(",");
}

// ---------------------------------------------------------------------------
// Provider-neutral email events (the normalized webhook shape)
// ---------------------------------------------------------------------------

/**
 * Provider-neutral email event types. The `email.` prefix is intentional — it
 * keeps the `WebhookHandlerMap` keys, `WEBHOOK_TO_STATUS`,
 * `WEBHOOK_TO_STATUS_FIELD`, and the outbound catalog all UNCHANGED.
 */
export type EmailEventType =
  | "email.sent"
  | "email.delivered"
  | "email.bounced"
  | "email.complained"
  | "email.delivery_delayed"
  | "email.opened"
  | "email.clicked"
  /**
   * The provider ACCEPTED the message, returned a message id, and then threw
   * it away. SES's `Reject` is the reference case: "the only possible value
   * [of `reason`] is `Bad content`, which means that Amazon SES detected that
   * the email contained a virus. When a message is rejected, Amazon SES stops
   * processing it, and doesn't attempt to deliver it to the recipient's mail
   * server."
   *
   * It is its own type rather than an `email.bounced` with some class, and
   * that distinction is the whole point: **a reject is OUR fault, not the
   * recipient's.** Their address is fine; our content carried a virus. A
   * `permanent` bounce auto-suppresses, so folding a reject onto one would let
   * a single bad attachment permanently block a deliverable address — silent,
   * irreversible from the customer's side, and discovered months later.
   *
   * So the engine treats it as TERMINAL (no later event is coming for that
   * message) and SUPPRESSING NOTHING: no `bounceCount` increment, no
   * suppression list, no effect on a bounce rate.
   *
   * Provider-neutral by construction even though only the Hogsend provider
   * emits it today — every ESP has an accepted-then-discarded outcome.
   */
  | "email.rejected"
  /**
   * A HUMAN REPLIED to a message we sent (PRD 16).
   *
   * The one member of this union that is not a status of our own send: every
   * other type reports what happened to the message on its way out, while this
   * reports a message coming BACK. It is here rather than in a channel of its
   * own because the provider is the thing that received it and the correlation
   * handle is a provider message id, which is exactly what this union is for.
   *
   * The facts ride on {@link EmailEvent.reply}. Deliberately NOT a status:
   * nothing about a reply changes the delivery state of the original send, so
   * this type has no `email_sends` status mapping and no timestamp column —
   * a delivered message that gets a reply is still delivered.
   */
  | "email.replied";

/**
 * Provider-neutral bounce classification. Drives suppression: `permanent`
 * auto-suppresses (the engine increments `bounceCount`), `complaint` suppresses
 * immediately, `transient` is recorded but never suppresses, and `unknown` is
 * the conservative default (recorded, never suppresses). Each provider's
 * classifier returns this from its own wire-specific bounce shape.
 */
export type BounceClass = "permanent" | "transient" | "complaint" | "unknown";

/**
 * The facts of an inbound reply, carried on `email.replied` (PRD 16).
 *
 * Everything here except {@link EmailReply.inReplyTo} came out of a message a
 * STRANGER composed, so it is treated as display data: bounded by the producer,
 * never executed, and never used to decide whose reply this is.
 *
 * `inReplyTo` is the exception, and the asymmetry is the whole security model.
 * `In-Reply-To` is a header the sender writes, so anyone could name another
 * customer's message id. The producer therefore never passes the CLAIM through
 * — it asks its own records "did this same tenant send that id?" and only sets
 * this field when the answer is yes. A consumer may key on it without
 * re-deciding the question; an uncorrelated reply simply omits it and says so
 * via {@link EmailReply.correlated} rather than being dropped.
 *
 * Deliberately no HTML: handing a consumer an attacker's markup to store and
 * later render is a stored-XSS surface, and "did a human reply, and what did
 * they say" is answered by the text part.
 */
export interface EmailReply {
  /** The address the reply arrived AT — asserted by the provider, not a header. */
  recipient: string;
  /** The sender's address, without any display name. Null when it carried none. */
  from: string | null;
  subject: string | null;
  /** Bounded plain text. Never HTML. */
  text: string | null;
  /** True when {@link EmailReply.text} was clipped by the producer's cap. */
  textTruncated: boolean;
  /** True only when {@link EmailReply.inReplyTo} is set and was PROVEN. */
  correlated: boolean;
  /**
   * The message id of OUR send this reply answers — proven by the producer
   * against its own records, or absent. Never the sender's raw claim.
   */
  inReplyTo?: string;
}

/**
 * The provider-neutral email event every provider's `verifyWebhook`/
 * `parseWebhook` normalizes its verbatim webhook into. This is the ONE shape the
 * engine's `dispatchWebhook` reads — Resend, Postmark, and SES all adapt their
 * wire payloads into this. The untouched provider payload is preserved in `raw`
 * as a handler escape hatch (cast to {@link LegacyResendWebhookEvent} for the
 * old Resend shape during the deprecation window).
 */
export interface EmailEvent {
  type: EmailEventType;
  /** Resend `email_id` | Postmark `MessageID` | SES `mail.messageId`. */
  messageId: string;
  /** ALL recipients (SES bounce/complaint carry many). */
  recipients: string[];
  /** ISO 8601 timestamp of the provider event. */
  occurredAt: string;
  /** Present on `email.bounced` / `email.complained`. Drives suppression. */
  bounce?: {
    class: BounceClass;
    code: string;
    reason?: string;
  };
  /**
   * Present on `email.rejected`, carrying the provider's reason VERBATIM
   * (SES documents `Bad content` as the only value today — do not parse it,
   * map it, or assume it stays the only one).
   *
   * Deliberately NOT folded into {@link EmailEvent.bounce}: `bounce` drives
   * suppression, and a reject must never reach that path. Keeping the reason
   * in its own field means no handler can accidentally read a reject as a
   * bounce class.
   */
  reject?: { reason: string };
  /** Present on `email.clicked` (native-tracking echo only; first-party owns clicks). */
  click?: { url: string; at?: string; ip?: string; ua?: string };
  /**
   * Present on `email.replied` — the inbound message's bounded facts. See
   * {@link EmailReply}. Absent everywhere else, so no status handler can read
   * a stranger's text as if it were our own send's metadata.
   */
  reply?: EmailReply;
  /** The untouched provider payload, for handler escape-hatch + debugging. */
  raw: unknown;
}

/**
 * Per-event handler map. Keys are UNCHANGED `email.*` event types; each handler
 * now receives the provider-neutral {@link EmailEvent}. Handler bodies that read
 * the old Resend shape (`event.data.email_id`, `event.data.bounce`) must switch
 * to `event.messageId` / `event.bounce` OR cast
 * `event.raw as LegacyResendWebhookEvent` during the deprecation window.
 */
export type WebhookHandlerMap = {
  [K in EmailEventType]?: (
    event: Extract<EmailEvent, { type: K }>,
  ) => void | Promise<void>;
};

/**
 * Thrown by `verifyWebhook` when the request was a non-delivery-status handshake
 * (e.g. SNS SubscriptionConfirmation, Postmark SubscriptionChange) that the
 * provider already handled. The webhook route catches it and returns 200.
 * Provider-specific body-shape knowledge stays entirely inside the provider —
 * the engine route NEVER sniffs the body.
 */
export class WebhookHandshakeSignal extends Error {
  constructor(readonly action: string) {
    super(action);
    this.name = "WebhookHandshakeSignal";
  }
}

// ---------------------------------------------------------------------------
// Legacy Resend-shaped webhook union (frozen escape hatch, one minor)
// ---------------------------------------------------------------------------

interface WebhookEventBase {
  created_at: string;
  data: {
    email_id: string;
    from: string;
    to: string[];
    subject: string;
    created_at: string;
  };
}

/** @deprecated Use {@link EmailEvent}. Frozen for one minor as a `raw` cast target. */
export interface EmailSentEvent extends WebhookEventBase {
  type: "email.sent";
}

/** @deprecated Use {@link EmailEvent}. Frozen for one minor as a `raw` cast target. */
export interface EmailDeliveredEvent extends WebhookEventBase {
  type: "email.delivered";
}

/** @deprecated Use {@link EmailEvent}. Frozen for one minor as a `raw` cast target. */
export interface EmailBouncedEvent extends WebhookEventBase {
  type: "email.bounced";
  data: WebhookEventBase["data"] & {
    bounce: {
      message: string;
      type: string;
    };
  };
}

/** @deprecated Use {@link EmailEvent}. Frozen for one minor as a `raw` cast target. */
export interface EmailComplainedEvent extends WebhookEventBase {
  type: "email.complained";
}

/** @deprecated Use {@link EmailEvent}. Frozen for one minor as a `raw` cast target. */
export interface EmailDeliveryDelayedEvent extends WebhookEventBase {
  type: "email.delivery_delayed";
}

/** @deprecated Use {@link EmailEvent}. Frozen for one minor as a `raw` cast target. */
export interface EmailOpenedEvent extends WebhookEventBase {
  type: "email.opened";
}

/** @deprecated Use {@link EmailEvent}. Frozen for one minor as a `raw` cast target. */
export interface EmailClickedEvent extends WebhookEventBase {
  type: "email.clicked";
  data: WebhookEventBase["data"] & {
    click: {
      link: string;
      timestamp: string;
      ipAddress: string;
      userAgent: string;
    };
  };
}

/**
 * @deprecated The Resend-shaped webhook union, frozen for one minor. It no
 * longer flows through `verifyWebhook`/`parseWebhook` — those now return the
 * provider-neutral {@link EmailEvent}. Cast `event.raw as WebhookEvent` (alias
 * {@link LegacyResendWebhookEvent}) inside a `webhookHandler` to keep reading the
 * old nested shape while you migrate to {@link EmailEvent} fields. Removed the
 * following minor.
 */
export type WebhookEvent =
  | EmailSentEvent
  | EmailDeliveredEvent
  | EmailBouncedEvent
  | EmailComplainedEvent
  | EmailDeliveryDelayedEvent
  | EmailOpenedEvent
  | EmailClickedEvent;

/**
 * @deprecated The Resend-shaped webhook union, frozen for one minor. Cast
 * `event.raw as LegacyResendWebhookEvent` inside a `webhookHandler` to keep
 * reading the old nested shape while you migrate to {@link EmailEvent} fields.
 * Removed the following minor.
 */
export type LegacyResendWebhookEvent = WebhookEvent;

/**
 * @deprecated Use {@link EmailEventType}. Kept for one minor as the type of the
 * legacy union's `type` discriminant.
 */
export type WebhookEventType = WebhookEvent["type"];

// ---------------------------------------------------------------------------
// Provider identity & capabilities
// ---------------------------------------------------------------------------

/**
 * Provider identity. `id` is the key the {@link EmailProviderRegistry} indexes
 * by and the `:providerId` the `POST /v1/webhooks/email/:providerId` route
 * dispatches on. `name` is the human label; `description` is optional prose.
 */
export interface EmailProviderMeta {
  id: string;
  name: string;
  description?: string;
}

/**
 * What the provider's wire can and can't do. Drives engine-side enforcement
 * decisions (the tracking-sovereignty boot WARN, the `scheduledAt` capability
 * gate). All flags are optional — an absent flag is treated conservatively.
 */
export interface EmailProviderCapabilities {
  /**
   * Whether the provider's OWN open/click tracking is active and the engine
   * cannot force it off per-send. `false` = the provider disables it per-send
   * (Postmark TrackOpens:false/TrackLinks:'None'; SES omit from config-set) and
   * the engine TRUSTS that. `true` = an account-level toggle the engine can't
   * reach (Resend) → the engine logs a boot WARN. First-party open/click
   * tracking is always the single source of truth.
   */
  nativeTracking?: boolean;
  /** Honors `SendEmailOptions.scheduledAt` (Resend yes; Postmark/SES no). */
  scheduledSend?: boolean;
  /**
   * Carries `SendEmailOptions.attachments` on its wire. Absence is NOT
   * consent — an absent flag means the provider CANNOT carry them, and the
   * engine must fail LOUDLY at send time rather than deliver the message
   * without its files: a receipt that arrives minus its invoice looks
   * delivered from every dashboard, and nobody notices until the customer
   * does. Only declare it once your `send` actually translates the field.
   */
  attachments?: boolean;
  /**
   * Has a crypto signature scheme (Resend svix; SES SNS cert). `false` = the
   * provider must fail-closed on its own (Postmark basic-auth).
   */
  signedWebhooks?: boolean;
  /**
   * Does this transport CONSUME an `Idempotency-Key` header — lift it off
   * `SendEmailOptions.headers` and onto its own request — rather than forward
   * it onto the delivered message?
   *
   * **DANGER. A provider that forwards `headers` verbatim MUST NOT set this.**
   * Resend (`headers`) and Postmark (`Headers`) both do, so setting it there
   * would stamp the engine's INTERNAL keys onto real customer mail: those keys
   * embed Hatchet run ids and journey wait labels
   * (`journeySend:<runId>:<site>:<template>`) and, on campaign sends, the
   * RECIPIENT'S OWN EMAIL ADDRESS (`campaign:<id>:<email>`). The failure is
   * silent — nothing errors, the mail just goes out carrying it — which is why
   * it is opt-in by explicit declaration and never inferred.
   *
   * Absent or `false` ⇒ the engine never volunteers the key; the delivered
   * message's headers are byte-for-byte what they were before this flag
   * existed. Absence is NOT consent. Only declare it if you have checked what
   * your `send` does with `options.headers`.
   *
   * Declaring it buys real replay protection: the engine hands over the same
   * replay-stable key the `email_sends` unique index dedups on, so a transport
   * that would otherwise have to hash the message bytes (which change on every
   * attempt — `prepareTrackedHtml` mints fresh tracked-link ids per send) can
   * guard a crash replay properly. An `Idempotency-Key` the CALLER put in
   * `options.headers` is passed through untouched either way.
   */
  consumesIdempotencyKey?: boolean;
}

// ---------------------------------------------------------------------------
// EmailProvider contract (the entire provider surface)
// ---------------------------------------------------------------------------

/**
 * The dumb delivery + webhook parse/verify contract every email provider
 * implements (Resend, Postmark, SES, …). All tracking, DB, preference, and
 * render logic lives in the engine's `createTrackedMailer`, never here.
 */
export interface EmailProvider {
  /**
   * Provider identity. `meta.id` is the key the {@link EmailProviderRegistry}
   * indexes by and the `:providerId` the webhook route dispatches on. Optional
   * for back-compat with providers built before the registry; the registry
   * falls back to `"resend"` when absent. Becomes required in a later
   * (breaking) phase — new providers should always supply it.
   */
  readonly meta?: EmailProviderMeta;
  /**
   * Optional declaration of what the provider's wire supports. Read by the
   * engine for the native-tracking boot WARN and the `scheduledAt` gate. Absent
   * is treated conservatively (no native tracking assumed, no scheduled send).
   */
  readonly capabilities?: EmailProviderCapabilities;
  /**
   * Optional sending-domain management capability ({@link DomainsCapability}).
   * PRESENCE IS THE GATE — no `capabilities` flag mirrors it. Absent ⇒ the
   * engine's domain-status service reports `supported: false` and the admin
   * domain POSTs return 501; everything else degrades gracefully.
   */
  readonly domains?: DomainsCapability;

  /** Deliver a single message. Returns the provider message id. */
  send(options: SendEmailOptions): Promise<SendResult>;

  /** Deliver a batch of messages. */
  sendBatch(emails: BatchEmailItem[]): Promise<{ results: SendResult[] }>;

  /**
   * Verify the provider's webhook (owns its OWN secrets, constructed-in) and
   * return a normalized {@link EmailEvent}. Throws on a bad signature. Throws
   * {@link WebhookHandshakeSignal} for non-status handshakes (the route 200s
   * those). MAY be async (SES must GET the SNS SubscribeURL).
   */
  verifyWebhook(opts: {
    payload: string;
    headers: Record<string, string>;
  }): Promise<EmailEvent> | EmailEvent;

  /** Parse an unsigned webhook payload (trusted contexts/tests). */
  parseWebhook(payload: string): EmailEvent;
}

/**
 * Identity factory for an {@link EmailProvider}. Mirrors `defineWebhookSource` /
 * `defineDestination` — it returns its argument unchanged but pins the literal
 * shape to the {@link EmailProvider} contract, so a typo in `meta` or a missing
 * method is caught at definition time rather than at the call site.
 */
export function defineEmailProvider(provider: EmailProvider): EmailProvider {
  return provider;
}
