import type { SesAttachment } from "../ses/types";

/**
 * The attachment vocabulary the relay judges sends by (PRD 17 task 4).
 *
 * Every constant and rule here is a HAND-SYNCED MIRROR of the pinned contract
 * in `@hogsend/core` (`providers/email.ts`: `EmailAttachment`,
 * `assertValidAttachments`, `attachmentByteLength` and the `MAX_ATTACHMENT_*`
 * / `ATTACHMENT_*_MAX` limits) — mirrored rather than imported, the same rule
 * `lib/sending-domains.ts` holds for `DnsRecord`/`DomainStatus`: the control
 * plane depends on no engine package for its own types. The names and VALUES
 * are kept identical to core's so a reader can grep both files and see they
 * agree; a change to either side must be made in both.
 *
 * The ONE deliberate divergence is the content shape. Core's neutral
 * `EmailAttachment` discriminates `Uint8Array | { base64: string }`, because
 * an in-process caller can hold raw bytes. This relay takes JSON over HTTP,
 * where a `Uint8Array` cannot cross the wire — so on the wire content is
 * base64, ALWAYS, as a bare string, and there is no discriminant to get
 * wrong. What the wire adds instead is a validity check core has no need for:
 * a caller who posts raw text where base64 was expected would otherwise get
 * silent corruption (`Buffer.from(s, "base64")` ignores invalid characters),
 * and this is the last layer that can still say so.
 */

// ---------------------------------------------------------------------------
// The wire shape
// ---------------------------------------------------------------------------

/** One attachment as it crosses the relay: core's shape with base64 content. */
export interface WireEmailAttachment {
  /** Shown to the recipient. Max {@link ATTACHMENT_FILENAME_MAX}; no CR/LF/NUL. */
  filename: string;
  /** The file's bytes, base64-encoded. ALWAYS base64 — see the header note. */
  content: string;
  /** Omitted → SES defaults. Never guessed from the filename. */
  contentType?: string;
  /** `inline` embeds into the HTML via {@link contentId}; default `attachment`. */
  disposition?: "attachment" | "inline";
  /** References an `inline` attachment from the HTML (`cid:` URL). */
  contentId?: string;
}

// ---------------------------------------------------------------------------
// The published limits (values identical to @hogsend/core — hand-synced)
// ---------------------------------------------------------------------------

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
 * Per-MESSAGE attachment count cap. SES's real quota is 500 MIME parts per
 * message, but nothing sane sends hundreds of files — a cheap explicit cap
 * here beats discovering the quota at the wire.
 */
export const MAX_ATTACHMENT_COUNT = 20;

/**
 * Total RAW bytes across ALL attachments on one MESSAGE.
 *
 * Two different numbers are in play and confusing them is the failure mode:
 * SES v2's ceiling is 40 MB AFTER base64 encoding, per message. Base64
 * inflates by 4/3, so 25 MiB of raw attachment bytes encodes to ~33.3 MB,
 * leaving headroom for the HTML body, the text alternative and headers inside
 * SES's 40 MB. Enforced on RAW (decoded) bytes because that is the number a
 * customer can check on their own file — counting the encoded string instead
 * would make the cap a third too permissive.
 */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/**
 * Thrown by {@link assertValidAttachments}. `code` mirrors core's
 * `InvalidAttachmentError.code`, so the relay's 400 slug and the engine
 * mailer's recorded failure spell the refusal identically.
 */
export class InvalidAttachmentError extends Error {
  readonly code = "invalid_attachment";
  constructor(message: string) {
    super(message);
    this.name = "InvalidAttachmentError";
  }
}

// ---------------------------------------------------------------------------
// Validation (rule-for-rule mirror of core's assertValidAttachments)
// ---------------------------------------------------------------------------

/**
 * MIME-style line wrapping is tolerated (whitespace is not content), matching
 * core's `attachmentByteLength`. The copy is made ONLY when whitespace is
 * actually present: `String.replace` on a 25 MiB attachment costs ~1.6s of
 * allocation, and this sits on the hot path of every attachment send, so the
 * common no-whitespace case pays a ~10ms scan instead.
 */
function stripWhitespace(value: string): string {
  return /\s/.test(value) ? value.replace(/\s+/g, "") : value;
}

/**
 * The standard alphabet, with `=` padding only at the very end. Deliberately a
 * bare character-class star and NOT the textbook grouped form
 * `(?:[A-Za-z0-9+/]{4})*…` — V8 executes a quantified GROUP with one stack
 * frame per repetition, so that regex throws `RangeError: Maximum call stack
 * size exceeded` on a perfectly valid ~20 MiB attachment (measured at 28M
 * chars on Node 22), which this route would surface as the 500 it must never
 * produce. A character class quantifier is a flat loop; the grouping rules the
 * regex can no longer express are the two length checks in {@link isBase64}.
 */
const BASE64_ALPHABET = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Strict base64, judged on an already-whitespace-stripped string.
 * `Buffer.from(value, "base64")` is NOT this check — it silently discards
 * anything it does not recognise, which is exactly the corruption this
 * validation exists to refuse.
 */
function isBase64(b64: string): boolean {
  if (!BASE64_ALPHABET.test(b64)) return false;
  // No encoding of any byte sequence leaves a remainder of one character…
  if (b64.length % 4 === 1) return false;
  // …and padding, when present, must complete a four-character group.
  if (b64.includes("=") && b64.length % 4 !== 0) return false;
  return true;
}

/** Decoded byte count of a whitespace-stripped base64 string — core's math. */
function decodedLength(b64: string): number {
  let padding = 0;
  if (b64.endsWith("==")) padding = 2;
  else if (b64.endsWith("=")) padding = 1;
  return Math.floor((b64.length * 3) / 4) - padding;
}

/**
 * Raw (pre-base64) byte length of one attachment's content — the decoded
 * length computed from the string, mirroring core's `{ base64 }` branch
 * exactly. Handles `=` padding, unpadded strings, and MIME-style line
 * wrapping (whitespace is not content).
 */
export function attachmentByteLength(attachment: WireEmailAttachment): number {
  return decodedLength(stripWhitespace(attachment.content));
}

/** One-decimal MiB rendering for the size error — same as core's. */
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
  attachment: WireEmailAttachment,
  index: number,
): string {
  const name = attachment.filename.trim();
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
 * The rules and their error sentences mirror core's `assertValidAttachments`
 * verbatim (minus the typeof branches zod has already enforced by the time
 * this runs), PLUS the wire-only base64-validity check. On CR/LF/NUL: SES
 * assembles the MIME itself, so we cannot inject a header even in principle —
 * rejected anyway, because "the layer below probably sanitizes this" is not a
 * control. Deliberately NO blocked-extension list: SES publishes and enforces
 * its own, and a vendored copy goes stale in the direction that hurts most.
 */
export function assertValidAttachments(
  attachments: WireEmailAttachment[],
): void {
  if (attachments.length > MAX_ATTACHMENT_COUNT) {
    throw new InvalidAttachmentError(
      `Too many attachments: ${attachments.length} (limit ${MAX_ATTACHMENT_COUNT})`,
    );
  }
  let totalBytes = 0;
  for (const [index, attachment] of attachments.entries()) {
    const label = describeAttachment(attachment, index);
    const { filename, content, contentType, contentId } = attachment;
    if (filename.trim().length === 0) {
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
    // Wire-only rule (core's Uint8Array leg has nothing to decode): content
    // that is not base64 would silently corrupt, so it is refused by name.
    // Stripped ONCE, shared with the byte count — see `stripWhitespace`.
    const b64 = stripWhitespace(content);
    if (!isBase64(b64)) {
      throw new InvalidAttachmentError(
        `${label} content is not valid base64 — the relay takes attachment content base64-encoded, always`,
      );
    }
    totalBytes += decodedLength(b64);
  }
  if (totalBytes > MAX_ATTACHMENT_BYTES) {
    throw new InvalidAttachmentError(
      `Attachments total ${formatMiB(totalBytes)} (${totalBytes} raw bytes), over the ${formatMiB(MAX_ATTACHMENT_BYTES)} limit (${MAX_ATTACHMENT_BYTES} bytes)`,
    );
  }
}

// ---------------------------------------------------------------------------
// Translation onto the SES seam
// ---------------------------------------------------------------------------

/**
 * The wire attachment onto the seam's `SesAttachment` — through the
 * `{ base64 }` wrapper, NEVER as bytes we decoded ourselves. The seam's
 * discriminant exists so the AWS layer knows not to base64 the content a
 * second time; the wire is always base64, so the wrapper is always the
 * truthful declaration.
 */
export function toSesAttachment(
  attachment: WireEmailAttachment,
): SesAttachment {
  return {
    filename: attachment.filename,
    content: { base64: attachment.content },
    ...(attachment.contentType !== undefined
      ? { contentType: attachment.contentType }
      : {}),
    ...(attachment.disposition !== undefined
      ? { disposition: attachment.disposition }
      : {}),
    ...(attachment.contentId !== undefined
      ? { contentId: attachment.contentId }
      : {}),
  };
}
