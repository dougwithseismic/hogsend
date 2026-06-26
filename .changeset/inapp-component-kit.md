---
"@hogsend/engine": minor
"@hogsend/db": minor
"@hogsend/core": minor
"@hogsend/cli": minor
"@hogsend/client": minor
"@hogsend/email": minor
"@hogsend/js": minor
"@hogsend/react": minor
"@hogsend/studio": minor
"@hogsend/plugin-posthog": minor
"@hogsend/plugin-resend": minor
"@hogsend/plugin-postmark": minor
"@hogsend/plugin-discord": minor
"@hogsend/plugin-telegram": minor
"hogsend": minor
"create-hogsend": minor
---

In-app component kit — survey/rating primitive, preference center, swipe-to-archive, BYO toast, and a notification-badge fix.

- **Survey / rating primitive** — a surface-neutral `<Survey>` email component and an in-app survey feed block (`SurveyBlockView`) plus `sendSurvey()`. Answers ride the existing event spine (no new write path) and are readable from journeys via `ctx.waitForEvent`. New read-only `GET /v1/admin/reporting/breakdown` aggregates any event by a property value (count, average, optional NPS).
- **`<PreferenceCenter>`** — per-category × per-channel notification preferences over `usePreferences`, bundleable into `<FeedPopover>` as a tab. New read-only `GET /v1/lists` catalog.
- **Swipe-to-archive** — brought into `@hogsend/react` as a first-class affordance (pointer/touch swipe + an accessible archive button, wired to the existing `markAsArchived`).
- **Toast** — polished default skin and first-class custom rendering (`renderToast`).
- **Notification bell badge** — fixed `box-sizing` so the unread count renders as a solid, pinned circle under any host CSS reset.
