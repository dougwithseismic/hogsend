import type { SesMessage } from "../ses/types";
import type { ParsedInboundMessage } from "./inbound-mime";

/**
 * THE MANDATORY FORWARD (PRD 16 task 6) — composing it.
 *
 * PRD 16: "A person replying to a human expects a human to read it. If we
 * intercept a reply and only emit an event, we have broken their business to
 * gain a feature." So whenever inbound is on, every received message produces a
 * forward, and `enable` refuses outright without an address to forward to.
 *
 * What gets forwarded is a RE-WRAPPED notification, not the raw MIME, and every
 * part of that choice is load-bearing:
 *
 *  - **Deliverability.** Relaying a stranger's bytes verbatim under our own
 *    envelope breaks their SPF and DMARC alignment at the receiving mailbox —
 *    the classic forwarding failure. A message composed by us, from the
 *    customer's own verified sending domain, is aligned and DKIM-signed.
 *  - **The seam stays the seam.** `SesClient.sendEmail` takes structured
 *    `Simple` content; raw-MIME relaying would need a second send verb on the
 *    frozen nineteen-verb contract (PRD 02/11/21), i.e. a second API surface to
 *    walk and to fake, for a worse result.
 *  - **Security.** PRD 16: "Do not parse eagerly into anything that executes;
 *    store, reference, and let the customer opt in to retrieval." The forward
 *    carries the BOUNDED text (`lib/inbound-mime.ts` caps it), the attachment
 *    MANIFEST and the S3 reference — never HTML, never attachment bytes.
 *
 * And `Reply-To` is what keeps it a conversation: the human hits reply and
 * reaches the person who wrote to them, not us.
 */

/** The local part the forward is sent FROM. See {@link forwardFromAddress}. */
export const INBOUND_FORWARD_LOCAL_PART = "replies";

/**
 * How much of the original text rides on the forward.
 *
 * The parse already clips at `MAX_INBOUND_TEXT_CHARS` (64 KiB), so this is a
 * second, tighter bound on the one string that reaches a real person's mailbox.
 * 32 KiB is far more than anyone types and small enough that a hostile sender
 * cannot use our forwarder to push a large message into a customer's inbox
 * under the customer's own domain.
 */
export const MAX_FORWARD_TEXT_CHARS = 32 * 1024;

/** How many attachments the manifest lists before it says "and N more". */
const MAX_FORWARD_ATTACHMENTS = 20;

/**
 * A single mailbox and nothing that could be a header.
 *
 * Shared shape with `ses-inbound-domains.ts`'s enable-time check, applied again
 * here to the SENDER's address — which, unlike the forwarding address, was
 * written by a stranger. It reaches `ReplyToAddresses`, a structured SES field
 * rather than a raw header, so this is not the only thing standing between us
 * and header injection; it is here because an unusable address must be DROPPED
 * rather than fail the whole send, and losing the reply-to is much better than
 * losing the forward.
 */
const ADDRESS_RE =
  /^[^\s@,;<>"]+@([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;

export interface InboundForwardInput {
  /** The customer's VERIFIED sending domain (`acme.com`). */
  domain: string;
  /** The human mailbox, from the domain's stored inbound config. */
  forwardTo: string;
  /** The envelope recipient the message arrived at. */
  recipient: string;
  /** The parse, or `null` when the message could not be read at all. */
  parsed: ParsedInboundMessage | null;
  /** Where the raw MIME is, so the customer can opt in to retrieving it. */
  storage: { bucket: string; key: string };
  /** Set when no event was emitted, so the forward says why. */
  suppressedReason?: string | null;
}

/**
 * The address a forward is sent FROM.
 *
 * The APEX sending domain, not `reply.<domain>`, and not the envelope recipient
 * the message arrived at. Two reasons, and both are failures we would only see
 * in production:
 *
 *  - the apex is the identity the customer actually verified with SES (inbound
 *    can only be enabled on a domain that is already a sending domain), so it
 *    is the one host we KNOW can send. Subdomain identity inheritance is real
 *    but is one more AWS behaviour to be right about for no gain here;
 *  - the local part is FIXED. The envelope recipient's local part is chosen by
 *    whoever sent the message — anyone may write to `<anything>@reply.acme.com`
 *    — and putting an attacker-chosen string into a header we compose is a
 *    surface with no upside.
 */
export function forwardFromAddress(domain: string): string {
  return `${INBOUND_FORWARD_LOCAL_PART}@${domain}`;
}

/**
 * Build the message that carries a received reply to the human who must read it.
 *
 * `Auto-Submitted: auto-forwarded` (RFC 3834) is not decoration. This forward IS
 * an automatic message: without the header, an out-of-office on the human's
 * mailbox may answer it, that answer can land back on `reply.<domain>`, and the
 * two systems talk to each other. It is the same loop the receive path's
 * `autoResponderReason` guard breaks from the other side, and a forwarder that
 * omits it is the thing that starts one.
 */
export function buildForwardMessage(input: InboundForwardInput): SesMessage {
  const { parsed } = input;
  const replyTo =
    parsed?.from && ADDRESS_RE.test(parsed.from) ? parsed.from : null;

  return {
    from: forwardFromAddress(input.domain),
    to: [input.forwardTo],
    ...(replyTo ? { replyTo: [replyTo] } : {}),
    subject: forwardSubject(parsed?.subject ?? null),
    text: forwardBody(input),
    headers: {
      // See the doc comment: this is the loop guard, from the sending side.
      "Auto-Submitted": "auto-forwarded",
      // So a mail client threads the forward next to the human's own copy, and
      // so an operator can find the row from the message. Both are OUR values —
      // the sender's claimed ids never become headers we emit.
      "X-Hogsend-Inbound-Recipient": input.recipient,
    },
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * `Fwd: ` + the original, or a plain statement when there was none.
 *
 * The subject is a display string the sender chose, already clipped by the
 * parse. Newlines cannot reach here (SES takes the subject as a structured
 * field, and the parser returns a single decoded header value), and the `Fwd: `
 * prefix is what tells the human at a glance that this is not addressed to
 * them personally.
 */
function forwardSubject(subject: string | null): string {
  const trimmed = subject?.trim();
  return trimmed ? `Fwd: ${trimmed}` : "Fwd: (no subject)";
}

function forwardBody(input: InboundForwardInput): string {
  const { parsed } = input;
  const lines: string[] = [
    `A reply arrived at ${input.recipient}.`,
    "",
    `From:    ${parsed?.from ?? "(no sender address)"}`,
    `To:      ${input.recipient}`,
    `Subject: ${parsed?.subject ?? "(no subject)"}`,
  ];

  if (input.suppressedReason) {
    // Said plainly, because the customer's expectation is that a reply drives
    // their journey. A message that was stored and deliberately not emitted
    // must not look identical to one that was.
    lines.push(
      "",
      `NOTE: no email.replied event was emitted for this message (${input.suppressedReason}).`,
    );
  }

  if (!parsed) {
    lines.push(
      "",
      "Hogsend could not read this message, so only the reference below is available.",
    );
  } else {
    const text = parsed.text ?? "";
    const clipped = text.slice(0, MAX_FORWARD_TEXT_CHARS);
    lines.push("", "----- the message -----", "", clipped || "(no text body)");
    if (parsed.textTruncated || text.length > MAX_FORWARD_TEXT_CHARS) {
      lines.push("", "[truncated — retrieve the stored message for the rest]");
    }
    if (parsed.attachments.length > 0) {
      lines.push("", "----- attachments (not forwarded) -----");
      for (const attachment of parsed.attachments.slice(
        0,
        MAX_FORWARD_ATTACHMENTS,
      )) {
        lines.push(
          `  ${attachment.filename ?? "(unnamed)"} — ${attachment.contentType}, ${attachment.size} bytes`,
        );
      }
      const hidden =
        parsed.attachments.length -
        MAX_FORWARD_ATTACHMENTS +
        (parsed.attachmentsTruncated ? 1 : 0);
      if (hidden > 0) lines.push(`  … and ${hidden} more`);
    }
  }

  lines.push(
    "",
    "----- the stored original -----",
    `  s3://${input.storage.bucket}/${input.storage.key}`,
  );
  return `${lines.join("\n")}\n`;
}
