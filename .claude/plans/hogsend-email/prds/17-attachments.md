# PRD 17 — Attachments

**Status:** `[ ]` · **Depends:** 03, 14 · **Boundary:** `packages/core`, `packages/engine`, `apps/cloud`, `packages/plugin-hogsend`, `packages/plugin-resend`, `packages/plugin-postmark`

## Goal

Send a file with an email. Invoices, receipts, tickets, CSV exports, contracts.

**This is the one real capability gap against Resend**, and it is a hard blocker rather than a nice
to have: a customer who needs to attach an invoice cannot use Hogsend at all, no matter how good the
journeys are. `SendEmailOptions` has no attachment field anywhere in the stack today.

## CORRECTION — the premise this PRD was written on was wrong

This PRD originally opened: *"SES `SendEmail` with Simple content CANNOT carry attachments … so we
assemble the full MIME message ourselves — multipart boundaries, base64 transfer encoding, headers."*
Task 1 existed to confirm exactly that from AWS's own documentation before writing code.

**Task 1 ran, and it refuted the premise.** SES v2's `Simple` content carries a first-class
`Attachments` array. From the SESv2 API reference (`SendEmail` request syntax):

```
"Simple": {
   "Attachments": [ { "ContentDescription", "ContentDisposition", "ContentId",
                      "ContentTransferEncoding", "ContentType", "FileName", "RawContent" } ],
   "Body": { … }, "Headers": [ … ], "Subject": { … }
}
```

Confirmed present in the installed SDK — `@aws-sdk/client-sesv2@3.1106.0`,
`dist-types/models/models_0.d.ts:537`, `Attachments?: Attachment[]` on the Simple `Message`, with
`RawContent: Uint8Array` and the SDK doing the base64 itself.

**So there is no MIME to assemble.** The two hardest tasks in the original plan — a hand-written
multipart assembler and a `sendRawEmail` verb on the SES seam — are both deleted. What remains is
threading a neutral field through layers that already exist. That is a materially smaller and
materially safer build: the highest-risk item was a bespoke MIME writer, and hand-rolled MIME is
where header-injection and encoding bugs live.

This is the fourth time in this wave that reading AWS's primary source changed the design (BYODKIM
`NextSigningKeyLength`, `DkimAttributes.Tokens`, the missing `REJECT` event, now this). The rule
holds: **the plan is never privileged over the primary source.**

## The facts, with citations

From *Service quotas in Amazon SES* (`ses/latest/dg/quotas.html`), Message quotas table:

> **Using the SES v2 API or SMTP** — Maximum message size (including attachments): **40 MB per
> message (after base64 encoding)**. Adjustable: **No**.

> Messages larger than 10MB are subject to bandwidth throttling, and depending on your sending rate,
> you may be throttled to as low as 40MB/s.

Same page, SES API sending quotas: **MIME parts: 500**, not adjustable. And **50 recipients per
message**, not adjustable.

Note the v1 API's ceiling is 10 MB and the v2 API's is 40 MB. We are on v2 (`SendEmailCommand` from
`@aws-sdk/client-sesv2`), so 40 MB is ours. Do not copy the 10 MB figure out of a blog post.

From the `Attachment` type reference (`ses/latest/APIReference-V2/API_Attachment.html`):

| Field | Required | Constraint |
| --- | --- | --- |
| `FileName` | **Yes** | max 255. *"Amazon SES restricts certain file extensions"* |
| `RawContent` | **Yes** | base64 over the wire; *"If you are accessing Amazon SES using an AWS SDK, the SDK takes care of the base 64-encoding for you"* |
| `ContentType` | No | 1–78 chars |
| `ContentDisposition` | No | `ATTACHMENT` \| `INLINE` |
| `ContentTransferEncoding` | No | `BASE64` \| `QUOTED_PRINTABLE` \| `SEVEN_BIT` |
| `ContentId` | No | 1–78; references an `INLINE` attachment from the HTML |
| `ContentDescription` | No | max 1000 |

`ContentType` capped at **78 characters** is the kind of constraint that is invisible until a real
`multipart/…; boundary=…`-shaped value hits it. Validate it.

And from `SendEmail`'s own `MessageId` response note, which is PRD 18's premise stated by AWS
directly:

> "It's possible for Amazon SES to accept a message without sending it. For example, this can happen
> when the message that you're trying to send has an attachment that contains a virus."

That is the whole reason PRD 18 shipped before this one.

## Locked decisions

- **The provider contract stays dumb.** `EmailProvider.send` gains attachments as neutral data
  (`{ filename, contentType?, content, disposition?, contentId? }`), NOT a provider-specific shape.
  Resend and Postmark both support attachments natively; SES takes them as structured fields. Each
  provider translates. Nobody writes MIME.
- **`content` is bytes, and the neutral type is explicit about which.** `Uint8Array` or a base64
  `string`, discriminated, never "whatever the caller had". The SES SDK wants `Uint8Array` and does
  its own base64; a caller who hands us a base64 string and gets it base64'd again produces a
  corrupt file that still sends. That failure is silent at every layer, which is what makes it worth
  a discriminant rather than a heuristic.
- **Tracking must survive.** `prepareTrackedHtml` rewrites links and injects the open pixel; the
  tracked HTML is what goes in `Body.Html` alongside the attachments. Attachments must not silently
  disable click tracking. Assert it.
- **Size is enforced at the edge, not discovered at the wire.** Reject an oversized message in the
  relay with an error naming the limit AND the actual size, before it reaches SES.
- **The customer-facing limit is stated in RAW bytes; the SES limit is 40 MB AFTER base64.** These
  are different numbers and the docs must say which they mean. Base64 inflates by 4/3, so 40 MB
  encoded is ~30 MB raw, and the HTML body, headers and encoding overhead come out of the same
  budget. Pick a customer-facing raw cap **below** that with real headroom, publish it, and enforce
  it on the raw byte count. Getting this wrong means a customer sends a file that fits and it fails.
- **We do NOT maintain our own blocked-extension list.** SES publishes one
  (`ses/latest/dg/mime-types.html`) and enforces it, and it moves. A vendored copy goes stale in the
  direction that hurts most: refusing a file SES would have accepted. Let SES refuse, and surface its
  refusal verbatim — the same rule PRD 18 applied to the reject reason.
- **Filenames are still validated for CR, LF and NUL.** SES assembles the MIME now, so we cannot
  inject a header even in principle. Reject them anyway: it costs three lines, and "the layer below
  probably sanitizes this" is not a control.
- **Content is bytes we never execute and never parse.** No thumbnailing, no preview, no archive
  inspection. Size, filename shape, and count. Nothing else.
- **Attachments are NOT stored by default.** `email_sends` records that a message HAD attachments,
  with their names, sizes and content types — not their bytes. Storing customer invoices indefinitely
  is a data-protection decision nobody has made.
- **Allowance and billing stay by MESSAGE, not by byte, until someone decides otherwise.** Flag it: a
  30 MB attachment costs materially more to send than a 10 KB email and the meter cannot see the
  difference.
- **`sendBatch` needs no separate work.** `AwsSesClient.sendBatch` is a bounded-concurrency loop over
  `sendEmail` (deliberately not `SendBulkEmail`, per its own comment), so attachments flow through it
  the moment `sendEmail` carries them. Assert that rather than building it.

## Acceptance criteria (EARS)

- WHEN a send includes no attachments, the system SHALL emit a `SendEmailCommand` byte-identical to
  today's, with no `Attachments` key present at all. Assert this; it is what proves the change is not
  a regression for every existing send.
- WHEN a send includes attachments, the system SHALL pass them as SES `Simple` content `Attachments`
  alongside the tracked HTML and the plain-text alternative.
- WHEN the total raw attachment size exceeds the published limit, the system SHALL reject the send
  before calling SES, with an error naming both the limit and the actual size.
- WHEN an attachment has no explicit content type, the system SHALL omit `ContentType` and let SES
  default, rather than guessing from the filename.
- WHEN a filename contains CR, LF or NUL, or exceeds 255 characters, the system SHALL reject it.
- WHEN a content type exceeds 78 characters, the system SHALL reject it rather than letting SES 400.
- WHEN attachments are present, first-party open and click tracking SHALL still be applied.
- WHEN a provider does not declare `capabilities.attachments`, the system SHALL fail loudly at send
  time rather than silently dropping the files.
- WHEN SES refuses an attachment on its own extension policy, the system SHALL surface SES's message
  verbatim rather than mapping it to a generic failure.

## Tasks

1. ~~**Confirm from AWS's docs**: the raw-message size ceiling, before-or-after base64, and the
   Simple-vs-Raw constraint.~~ **DONE — and it refuted the premise. See the correction above.**
   _Boundary:_ none · _Depends:_ none
2. **`attachments?: EmailAttachment[]` on `SendEmailOptions`** in `@hogsend/core`, plus
   `capabilities.attachments` so a provider can declare it cannot. Include the discriminated
   bytes-vs-base64 content shape and the validation helper (filename, content type, size).
   _Boundary:_ `packages/core` · _Depends:_ none
3. **SES seam**: `SesMessage` carries attachments; `toSendEmailFields` maps them onto Simple
   `Attachments`; contract + `aws.ts` + `fake.ts` move together, as every seam change in this wave has.
   _Boundary:_ `apps/cloud` · _Depends:_ task 2
4. **Relay schema + size gate** on `POST /api/email/send` and `/send-batch`.
   _Boundary:_ `apps/cloud` · _Depends:_ task 3
5. **plugin-hogsend passes attachments through** and declares the capability.
   _Boundary:_ `packages/plugin-hogsend` · _Depends:_ task 2
6. **Engine mailer threads attachments** through the tracked pipeline, after tracking is applied, and
   records names/sizes/types (never bytes) on `email_sends`.
   _Boundary:_ `packages/engine` · _Depends:_ task 2
7. **Resend and Postmark translation**, so the feature is not Hogsend-only.
   _Boundary:_ `packages/plugin-resend`, `packages/plugin-postmark` · _Depends:_ task 2
8. **Tests**, including the byte-identical no-attachment path, the CR/LF filename case, the
   oversize refusal, and `sendBatch` inheriting attachments with no batch-specific code.
   _Boundary:_ all touched · _Depends:_ tasks 2-7

## Seams

- Whether attachment bytes are ever stored, and for how long, is a data-protection decision for Doug.
  Default is "never stored" until he says otherwise.
- Whether large attachments should meter differently from a plain send.
- The 500-MIME-part quota is far above any sane attachment count, but nothing enforces a count cap
  today. Pick one when the size cap lands; it is cheaper than discovering it at the wire.

## Done when

A journey can attach a PDF, the message reaches SES as Simple content with an `Attachments` array,
tracking still works, an oversized send is refused with a clear error naming both numbers, and gates
are green.

## Implementation Notes
