---
"@hogsend/engine": patch
"@hogsend/db": patch
"@hogsend/core": patch
"@hogsend/cli": patch
"@hogsend/client": patch
"@hogsend/email": patch
"@hogsend/plugin-posthog": patch
"@hogsend/plugin-resend": patch
"@hogsend/plugin-postmark": patch
"@hogsend/plugin-discord": patch
"@hogsend/plugin-telegram": patch
"@hogsend/studio": patch
"hogsend": patch
"create-hogsend": patch
---

Studio: per-journey detail pages.

Journeys in Studio were a single list with an inline funnel — there was no way to
drill into one. Clicking a journey now opens a dedicated `/journeys/:id` page:

- **Definition** — trigger event + `where` conditions, `exitOn` rules, `entryLimit`,
  and the `suppress` window.
- **Funnel** — the existing enrolled → sent → opened → clicked → completed funnel.
- **Email** — the templates the journey has actually sent, with sent/opened/clicked
  counts and an inline rendered preview (reusing the template-preview iframe). Scoped
  to email; other channels (Discord/Telegram) aren't shown.
- **Instances** — a filterable, paginated browser of `journey_states`; each row opens
  a slide-out drawer with the instance's transition log and enrollment context.

Backed by a new `GET /v1/admin/journeys/:id/templates` endpoint (distinct templates
sent within the journey, derived from `email_sends` joined through `journey_states`).
`StatusBadge` also gained journey-instance statuses (active/waiting/completed/exited)
so they're visually distinguishable.

The rest of the `@hogsend/*` line moves with this patch to stay on a single engine
version line.
