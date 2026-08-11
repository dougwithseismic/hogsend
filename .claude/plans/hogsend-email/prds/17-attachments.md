# PRD 17 — Attachments

**Status:** `[ ]` · **Depends:** 03, 14 · **Boundary:** `packages/core`, `packages/engine`, `apps/cloud`, `packages/plugin-hogsend`

## Goal

Send a file with an email. Invoices, receipts, tickets, CSV exports, contracts.

**This is the one real capability gap against Resend**, and it is a hard blocker rather than a nice
to have: a customer who needs to attach an invoice cannot use Hogsend at all, no matter how good the
journeys are. `SendEmailOptions` has no attachment field anywhere in the stack today.

## The thing that makes this a real build, not a field addition

**SES `SendEmail` with Simple content CANNOT carry attachments.** Simple content is subject, HTML and
text, and nothing else. Attachments require **Raw** content: we assemble the full MIME message
ourselves — multipart boundaries, base64 transfer encoding, headers — and hand SES the bytes.

So the relay grows a second send mode, and every layer of the pipeline that currently assumes "HTML
string in, provider sends it" has to learn there is another shape. Confirm the exact SES constraint
and the raw-message size ceiling from AWS's own documentation before writing code; do not infer them
from an SDK type. That discipline is what caught the BYODKIM failure and the `ses:TagResource` gap.

## Locked decisions

- **The provider contract stays dumb.** `EmailProvider.send` gains attachments as neutral data
  (`{ filename, contentType, content }`), NOT a provider-specific shape. Resend and Postmark both
  support attachments natively; the Hogsend provider assembles MIME. Each provider translates.
- **Tracking must survive.** `prepareTrackedHtml` rewrites links and injects the open pixel BEFORE the
  message is assembled. Assembling MIME after tracking, never instead of it — an attachment must not
  silently disable click tracking.
- **Size is enforced at the edge, not discovered at the wire.** Reject an oversized message in the
  relay with a clear error naming the limit, before it reaches SES. Metering already counts the
  streamed body (PRD 03); attachments make that count matter far more.
- **Base64 inflates by ~33%.** The customer-facing limit and the SES limit are different numbers and
  the docs must state which one they mean. Getting this wrong means a customer sends a file that
  fits, and it bounces.
- **Content is bytes we never execute and never parse.** We are a pipe. No thumbnailing, no preview,
  no archive inspection. The only inspection is size and, if we choose it, a filename/extension
  policy — and if we do add one, it is a published list, not a guess.
- **Attachments are NOT stored by default.** `email_sends` records that a message HAD attachments and
  their names and sizes, not their bytes. Storing customer invoices indefinitely is a data-protection
  decision nobody has made, and quietly doing it would be the wrong default.
- **Allowance and billing are by MESSAGE, not by byte, until someone decides otherwise.** Flag it: a
  10MB attachment costs materially more to send than a 10KB email, and the current meter cannot see
  the difference.

## Acceptance criteria (EARS)

- WHEN a send includes no attachments, the system SHALL use the existing Simple-content path and the
  wire SHALL be byte-identical to today's. Assert this; it is what proves the change is not a
  regression for every existing send.
- WHEN a send includes attachments, the system SHALL assemble a MIME message carrying the tracked
  HTML, the plain-text alternative, and each attachment, and SHALL send it as raw content.
- WHEN a message exceeds the configured size limit, the system SHALL reject it before calling SES,
  with an error naming the limit and the actual size.
- WHEN an attachment has no explicit content type, the system SHALL default to
  `application/octet-stream` rather than guessing from the filename.
- WHEN a filename contains characters that would break MIME headers (CR, LF, quotes), the system
  SHALL sanitize or reject it — a header-injection vector through a filename is the obvious attack.
- WHEN attachments are present, first-party open and click tracking SHALL still be applied.
- WHEN a provider does not support attachments, the system SHALL fail loudly at send time rather than
  silently dropping the files.

## Tasks

1. **Confirm from AWS's docs**: the exact raw-message size ceiling, whether it is measured before or
   after base64, and the Simple-vs-Raw constraint. Record citations.
   _Boundary:_ none · _Depends:_ none
2. **`attachments?: EmailAttachment[]` on `SendEmailOptions`** in `@hogsend/core`, plus a
   `capabilities.attachments` flag so a provider can declare it cannot.
   _Boundary:_ `packages/core` · _Depends:_ task 1
3. **MIME assembly** in the relay, with boundary generation, base64 encoding, and header sanitization.
   Unit-test the assembler against a parser rather than against a string snapshot.
   _Boundary:_ `apps/cloud` · _Depends:_ task 1
4. **Raw send** on the SES seam (`sendRawEmail`), contract + `aws.ts` + Fake together.
   _Boundary:_ `apps/cloud` · _Depends:_ task 3
5. **Relay schema + size gate.**
   _Boundary:_ `apps/cloud` · _Depends:_ tasks 3, 4
6. **plugin-hogsend passes attachments through** and declares the capability.
   _Boundary:_ `packages/plugin-hogsend` · _Depends:_ task 2
7. **Engine mailer threads attachments** through the tracked pipeline, after tracking is applied.
   _Boundary:_ `packages/engine` · _Depends:_ task 2
8. **Resend and Postmark translation**, so the feature is not Hogsend-only.
   _Boundary:_ `packages/plugin-resend`, `packages/plugin-postmark` · _Depends:_ task 2
9. **Tests**, including the byte-identical no-attachment path and the filename header-injection case.
   _Boundary:_ all touched · _Depends:_ tasks 2-8

## Seams

- Whether attachment bytes are ever stored, and for how long, is a data-protection decision for Doug.
  Default is "never stored" until he says otherwise.
- Whether large attachments should meter differently from a plain send.

## Done when

A journey can attach a PDF, the message arrives with the file intact and tracking still working, an
oversized send is refused with a clear error, and gates are green.

## Implementation Notes
