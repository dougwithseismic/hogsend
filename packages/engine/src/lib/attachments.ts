import type { EmailAttachment, EmailProvider } from "@hogsend/core";
import { assertValidAttachments, attachmentByteLength } from "@hogsend/core";

/**
 * Thrown when a send carries attachments but the resolved provider does not
 * declare `capabilities.attachments`. A named class (mirroring
 * `TestModeNoRedirectError`) so callers can branch on it without
 * string-matching the message; the message itself names the provider id AND
 * the capability so an operator reading a log can act on it directly.
 */
export class AttachmentsUnsupportedError extends Error {
  readonly code = "attachments_unsupported";
  constructor(readonly providerId: string) {
    super(
      `Email provider "${providerId}" does not declare capabilities.attachments — ` +
        `refusing to send a message without its files. Switch to a provider that ` +
        `carries attachments, or drop the attachments from this send.`,
    );
    this.name = "AttachmentsUnsupportedError";
  }
}

/**
 * The engine-side attachment gate, run BEFORE any other send work (no DB row,
 * no render, no provider call happens first). Two checks, in order:
 *
 * 1. `assertValidAttachments` — shape/size/count validation. The relay
 *    validates too, and that is deliberate defence in depth rather than
 *    duplication: a Resend or Postmark send never passes through the relay at
 *    all, so for those providers THIS is the only gate before the wire.
 *
 * 2. The capability gate — throw unless the provider DECLARES
 *    `capabilities.attachments === true`. The quiet alternative (send the
 *    message, drop the files) is genuinely tempting and genuinely wrong: a
 *    receipt that arrives without its invoice looks *delivered* from every
 *    dashboard, from `email_sends`, and from the provider's own logs — nobody
 *    discovers it until the customer does. Absence of the flag is NOT consent
 *    (same rule as `consumesIdempotencyKey`): an absent or `false` flag means
 *    the provider cannot carry the files, so the send must fail loudly here,
 *    before anything is written or dispatched.
 */
export function assertAttachmentsSendable(
  provider: EmailProvider,
  attachments: EmailAttachment[],
): void {
  assertValidAttachments(attachments);
  if (provider.capabilities?.attachments !== true) {
    throw new AttachmentsUnsupportedError(provider.meta?.id ?? "resend");
  }
}

/**
 * One recorded metadata entry per attachment on the `email_sends` row:
 * filename, raw byte size, and content type when declared.
 */
export interface AttachmentSendMetadata {
  filename: string;
  sizeBytes: number;
  contentType?: string;
}

/**
 * What `email_sends.metadata.attachments` records: that the message HAD
 * attachments — their filenames, raw sizes, and content types. NEVER the
 * content itself. Storing customer invoices indefinitely is a data-protection
 * decision nobody has made, and quietly making it here by persisting bytes
 * would be the wrong default. Size comes from `attachmentByteLength` (raw
 * bytes, decoded for `{ base64 }` content) so the recorded number matches the
 * one the size cap enforces.
 */
export function attachmentSendMetadata(
  attachments: EmailAttachment[],
): AttachmentSendMetadata[] {
  return attachments.map((attachment) => ({
    filename: attachment.filename,
    sizeBytes: attachmentByteLength(attachment),
    ...(attachment.contentType !== undefined
      ? { contentType: attachment.contentType }
      : {}),
  }));
}
