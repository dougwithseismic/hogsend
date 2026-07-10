---
"@hogsend/engine": minor
"@hogsend/core": minor
"@hogsend/email": minor
"@hogsend/db": minor
"@hogsend/cli": minor
"@hogsend/client": minor
"@hogsend/js": minor
"@hogsend/react": minor
"@hogsend/plugin-posthog": minor
"@hogsend/plugin-resend": minor
"@hogsend/plugin-postmark": minor
"@hogsend/plugin-discord": minor
"@hogsend/plugin-telegram": minor
"@hogsend/studio": minor
"hogsend": minor
"create-hogsend": minor
---

Studio campaign detail pages at journey-page fidelity.

**Campaign detail view.** Campaigns rows now click through to `/studio/campaigns/:id` — the broadcast sibling of the journey detail page. The page leads with a lifecycle band in the flow view's node-card language (created → scheduled → sending → terminal; the live stage carries a pulsing "now" chip, a `sent/total` counter, and a progress bar; stages that never happened render dashed), then a Definition card (audience, template, subject/from overrides, schedule), a Delivery funnel (recipients → sent → delivered → opened → clicked with per-stage drop badges, plus a skipped/failed/bounced/complained strip), the template's engagement row with an inline preview, and a per-recipient sends browser (cumulative Opened/Clicked/Bounced/Failed chips) that opens the shared send-detail drawer. In-flight campaigns poll every 4s so a live blast visibly advances; cancel (with the same chunk-boundary confirm copy) is available from both the list and the detail header.

**New admin surfaces backing the page.** `GET /v1/admin/campaigns/:id/stats` aggregates post-dispatch engagement (delivered/opened/clicked/bounced/complained/failed + `lastSentAt`) from the campaign's `email_sends` rows, attributed via the deterministic `campaign:<id>:<email>` idempotency key — now minted and matched through one shared `campaignSendKey`/`campaignSendKeyPattern` helper so the format can't drift. `GET /v1/admin/emails` accepts `campaignId` to list one campaign's sends (composes with the existing status/engagement filters). Campaign responses (data plane + admin) additionally carry the per-campaign `subject` and `fromEmail` overrides.

**Shared crimzon primitives.** The funnel stage-strip geometry (`FunnelStages`/`FunnelNotes`) and the sandboxed `TemplatePreviewFrame` are extracted into shared Studio components; the journey funnel and journey email card now render through them, so journey and campaign pages speak one visual language.

No migrations; API changes are additive.
