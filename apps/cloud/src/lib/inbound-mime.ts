import PostalMime from "postal-mime";

/**
 * RAW MIME FROM STRANGERS -> a small, bounded set of values.
 *
 * This is the most hostile input the control plane accepts. Anyone on the
 * internet can send a message to `reply.<customer>.com` and every byte of it
 * arrives here. PRD 16: "Do not parse eagerly into anything that executes;
 * store, reference, and let the customer opt in to retrieval."
 *
 * **The parser is `postal-mime`, and the reason is its dependency graph.**
 * It has ZERO runtime dependencies, is pure ESM/TypeScript, ships its own
 * types, and is maintained by Andris Reinman / Postal Systems (the author of
 * Nodemailer). The obvious alternative, `mailparser`, is from the same author
 * and is equally maintained, but pulls a dozen transitive packages
 * (`iconv-lite`, `libmime`, `libqp`, `html-to-text`, `nodemailer`, `tlds`, ...)
 * into the process that handles attacker-controlled bytes. When the input is
 * hostile, the supply-chain surface IS the security property, so the parser
 * with no supply chain wins. It also parses from a `Uint8Array` without needing
 * a stream, which is what lets the size cap live entirely upstream of it.
 *
 * Four rules this module keeps, each because breaking it is silent:
 *
 *  1. **Attachment BYTES never leave.** The parser has to decode a part to know
 *     its length, so bytes exist transiently inside `parse`; nothing here
 *     returns, stores or forwards them. What comes out is a MANIFEST -
 *     filename, content type, size - and the manifest is capped in both count
 *     and per-field length.
 *  2. **Everything returned is BOUNDED.** A subject, a display address and a
 *     text body are all attacker-sized, and all three end up in a database row
 *     and on a wire to a tenant instance. Truncation is stated
 *     (`textTruncated`) rather than silent.
 *  3. **Nothing is executed and no HTML is returned.** The `html` part is
 *     parsed (it is part of the message) and deliberately discarded: the event
 *     a journey waits on needs "did a human reply, and what did they say",
 *     which is the text part. Handing a tenant instance an attacker's HTML to
 *     store and later render is a stored-XSS surface we can simply not have.
 *  4. **Loop protection is a REFUSAL TO EMIT, not a drop.** See
 *     {@link autoResponderReason}.
 */

/**
 * The parser's own limits, passed on every parse.
 *
 * `maxHeadersSize` bounds a header bomb (a million `Received:` lines) and
 * `maxNestingDepth` bounds a multipart bomb (a message nested inside itself
 * two thousand times). Both are cheap, and both are the kind of input that
 * arrives specifically because this endpoint is public.
 */
const MAX_HEADERS_BYTES = 256 * 1024;
const MAX_NESTING_DEPTH = 24;
const MAX_RFC822_NESTING_DEPTH = 4;

/**
 * How much text body rides on the wire to the tenant instance.
 *
 * 64 KiB is far more than a human types into a reply and far less than a
 * message can carry, so it bounds what one hostile sender can make us insert
 * into a tenant's database. A journey waiting on `email.replied` branches on
 * whether a human answered, and no branch needs the 200th kilobyte.
 */
export const MAX_INBOUND_TEXT_CHARS = 64 * 1024;

/** A subject is a display string. Longer than this is a payload, not a subject. */
const MAX_SUBJECT_CHARS = 998;

/** An address that will not fit in one is not an address we can act on. */
const MAX_ADDRESS_CHARS = 320;

/** A filename is displayed, never used to open anything. Bounded anyway. */
const MAX_FILENAME_CHARS = 255;

/**
 * How many attachments are listed. A message with 10,000 parts is real, and
 * putting 10,000 rows of manifest on a wire is not. The overflow is COUNTED
 * (`attachmentsTruncated`) rather than pretended away.
 */
const MAX_ATTACHMENT_MANIFEST = 50;

/**
 * How many correlation candidates are considered.
 *
 * `References` grows by one message id per hop, so a long thread legitimately
 * carries dozens, and a hostile sender can carry a hundred thousand. The
 * candidates become an `IN (...)` against the relay's busiest table, so the
 * list is capped at the newest few: RFC 5322 puts the immediate parent LAST in
 * `References`, and `In-Reply-To` is always tried first.
 */
export const MAX_CORRELATION_CANDIDATES = 10;

export interface InboundAttachmentRef {
  filename: string | null;
  contentType: string;
  /** Decoded size in bytes. The bytes themselves are discarded. */
  size: number;
}

export interface ParsedInboundMessage {
  /** The sender's own `Message-ID`, unverified. */
  messageId: string | null;
  /** `From:`, address only. A display name is not an identity. */
  from: string | null;
  subject: string | null;
  /** Bounded plain-text body. Never HTML. */
  text: string | null;
  textTruncated: boolean;
  /**
   * Message ids this sender CLAIMS to be answering, newest-first and
   * UNVERIFIED. `In-Reply-To` leads; `References` follows in reverse order
   * (RFC 5322 puts the immediate parent last).
   */
  correlationCandidates: string[];
  /** The raw `In-Reply-To` id, for the record. Unverified. */
  inReplyTo: string | null;
  attachments: InboundAttachmentRef[];
  attachmentsTruncated: boolean;
  /** `Auto-Submitted`, verbatim and lowercased, or null. */
  autoSubmitted: string | null;
  /** `Precedence`, verbatim and lowercased, or null. */
  precedence: string | null;
}

/**
 * Parse one received message into bounded values.
 *
 * Takes the raw bytes rather than a stream, deliberately: the size cap is
 * enforced BEFORE anything is read (see `services/email-inbound-objects.ts`),
 * so by the time bytes reach here they are already known to fit a budget. A
 * streaming parse would move that decision inside the parser, where "refuse"
 * becomes "abort halfway through", and a half-parsed hostile message is a
 * worse thing to hold than none.
 */
export async function parseInboundMime(
  raw: Uint8Array,
): Promise<ParsedInboundMessage> {
  const email = await PostalMime.parse(raw, {
    maxHeadersSize: MAX_HEADERS_BYTES,
    maxNestingDepth: MAX_NESTING_DEPTH,
    maxRfc822NestingDepth: MAX_RFC822_NESTING_DEPTH,
  });

  const text = clip(email.text ?? null, MAX_INBOUND_TEXT_CHARS);
  const inReplyTo = firstMessageId(email.inReplyTo);
  const attachments = email.attachments ?? [];

  return {
    messageId: firstMessageId(email.messageId),
    from: clip(addressOf(email.from), MAX_ADDRESS_CHARS),
    subject: clip(email.subject ?? null, MAX_SUBJECT_CHARS),
    text,
    textTruncated: (email.text?.length ?? 0) > MAX_INBOUND_TEXT_CHARS,
    inReplyTo,
    correlationCandidates: correlationCandidates(inReplyTo, email.references),
    attachments: attachments
      .slice(0, MAX_ATTACHMENT_MANIFEST)
      .map((attachment) => ({
        filename: clip(attachment.filename, MAX_FILENAME_CHARS),
        contentType: attachment.mimeType || "application/octet-stream",
        // The ONLY thing read off the decoded content, and it is a length.
        size: contentLength(attachment.content),
      })),
    attachmentsTruncated: attachments.length > MAX_ATTACHMENT_MANIFEST,
    autoSubmitted: headerValue(email.headers, "auto-submitted"),
    precedence: headerValue(email.headers, "precedence"),
  };
}

/**
 * Why this message must NOT produce an event, or `null` to emit.
 *
 * PRD 16 makes this mandatory rather than a follow-on, and the reason is a real
 * failure mode rather than tidiness: our own `email.replied` can start a
 * journey step that sends mail, that mail reaches an out-of-office responder,
 * the responder answers our reply address, and the two systems talk to each
 * other until somebody notices. The loop is broken by refusing to EMIT, never
 * by refusing to store or forward - the human still gets their vacation notice.
 *
 * `Auto-Submitted` (RFC 3834) is authoritative: the spec says an automatic
 * responder MUST set it, and the ONLY value that means "a person wrote this" is
 * `no`. So anything other than `no` suppresses, including a value we have never
 * seen, because the safe direction for a loop guard is to emit less.
 *
 * `Precedence: bulk` is the older convention mailing lists and auto-responders
 * still use. `list` and `junk` are the other two traditional values and they
 * suppress too: none of the three is a human typing a reply.
 */
export function autoResponderReason(
  message: Pick<ParsedInboundMessage, "autoSubmitted" | "precedence">,
): "auto_submitted" | "precedence_bulk" | null {
  const autoSubmitted = message.autoSubmitted?.trim().toLowerCase();
  if (autoSubmitted) {
    // RFC 3834 allows parameters (`auto-replied; owner@example.com`), so the
    // comparison is on the keyword before any `;`. A whole-string compare would
    // read `no; ...` as unknown and suppress a real human's reply.
    const keyword = autoSubmitted.split(";")[0]?.trim() ?? "";
    if (keyword !== "no") return "auto_submitted";
  }

  const precedence = message.precedence?.trim().toLowerCase();
  if (precedence === "bulk" || precedence === "list" || precedence === "junk") {
    return "precedence_bulk";
  }

  return null;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** The LAST occurrence of a header, lowercased. */
function headerValue(
  headers: { key: string; value: string }[] | undefined,
  name: string,
): string | null {
  let found: string | null = null;
  for (const header of headers ?? []) {
    // Last wins rather than first. A header prepended by a relay does not
    // displace one the responder set, and a duplicate `Auto-Submitted: no`
    // prepended by a hostile sender must not talk us out of suppressing.
    if (header.key.toLowerCase() === name) found = header.value;
  }
  return found === null ? null : found.trim().toLowerCase().slice(0, 200);
}

/** `Mailbox | group | undefined` -> a bare address, or null. */
function addressOf(from: unknown): string | null {
  if (!from || typeof from !== "object") return null;
  const address = (from as { address?: unknown }).address;
  return typeof address === "string" && address.length > 0 ? address : null;
}

function clip(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  return value.length > max ? value.slice(0, max) : value;
}

/** A decoded attachment's length, whatever representation the parser chose. */
function contentLength(content: ArrayBuffer | Uint8Array | string): number {
  if (typeof content === "string") return Buffer.byteLength(content, "utf8");
  if (content instanceof Uint8Array) return content.byteLength;
  return content.byteLength;
}

/**
 * A `<...>` message id, angle brackets stripped and bounded.
 *
 * The value is attacker-controlled and ends up in a SQL parameter and a
 * database column, so the shape is constrained here rather than trusted: no
 * whitespace, no angle brackets, and short enough that a megabyte of junk in an
 * `In-Reply-To` cannot become a megabyte-wide `IN (...)` predicate.
 */
const MESSAGE_ID_PATTERN = /<([^<>\s]{1,255})>/g;
const BARE_MESSAGE_ID_PATTERN = /^[^<>\s]{1,255}$/;

function firstMessageId(value: string | undefined): string | null {
  if (!value) return null;
  const bracketed = messageIds(value);
  if (bracketed.length > 0) return bracketed[0] ?? null;
  // Some senders omit the brackets. Accepted only when the WHOLE value is one
  // plausible id, never as a substring of something longer.
  const trimmed = value.trim();
  return BARE_MESSAGE_ID_PATTERN.test(trimmed) ? trimmed : null;
}

function messageIds(value: string | undefined): string[] {
  if (!value) return [];
  const out: string[] = [];
  // Bounded scan: `matchAll` over a hostile 40 MB header would be the same
  // unbounded work the size cap exists to prevent.
  for (const match of value.slice(0, 64 * 1024).matchAll(MESSAGE_ID_PATTERN)) {
    const id = match[1];
    if (id) out.push(id);
  }
  return out;
}

/**
 * The ids to test against this environment's sends, newest-first.
 *
 * `In-Reply-To` first because it names the immediate parent explicitly, then
 * `References` REVERSED because RFC 5322 orders it oldest-first and the parent
 * is therefore last. Deduplicated, and capped: see
 * {@link MAX_CORRELATION_CANDIDATES}.
 */
function correlationCandidates(
  inReplyTo: string | null,
  references: string | undefined,
): string[] {
  const ordered = [
    ...(inReplyTo ? [inReplyTo] : []),
    ...messageIds(references).reverse(),
  ];
  return [...new Set(ordered)].slice(0, MAX_CORRELATION_CANDIDATES);
}
