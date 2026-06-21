---
"@hogsend/engine": minor
"@hogsend/core": minor
"@hogsend/db": minor
"@hogsend/email": minor
"@hogsend/cli": minor
"@hogsend/client": minor
"@hogsend/studio": minor
"@hogsend/plugin-discord": minor
"@hogsend/plugin-posthog": minor
"@hogsend/plugin-postmark": minor
"@hogsend/plugin-resend": minor
"@hogsend/plugin-telegram": minor
"hogsend": minor
---

feat(connectors): @hogsend/plugin-telegram + live-only journey_states unique index

Adds `@hogsend/plugin-telegram` — an inbound webhook connector (messages, `/start`
deep-link, `/link` email-confirm cold connect) with journey-callable
`sendMessage`/`dm` actions and Redis-token linking (peek-then-consume so a Telegram
webhook retry can't burn a link mid-flight).

Engine: `uq_user_journey_active` is now a PARTIAL unique index scoped to live rows
(`status IN ('active','waiting')`) so an `unlimited` journey can complete more than
once per user — the old full `(user_id, journey_id, status)` index threw `23505` on
the second completion. Ships migration `0029`. `contacts.properties.telegram` now
deep-merges (mirrors `discord`).

All engine-line packages are bumped uniformly to keep the version line and the
scaffold's caret pins consistent.
