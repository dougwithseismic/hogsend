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

Promote a Journey Blueprint to a code-first `defineJourney()` file.

- New `hogsend blueprints promote [id...]` CLI command — generates a `defineJourney()` TypeScript file from one or more blueprints, registers it in `src/journeys/index.ts` on a fresh git branch, prints the staged diff, and — after confirmation — marks each blueprint promoted. Never commits or pushes. `hogsend blueprints list` shows every blueprint's status, trigger, and promotion state.
- New engine capability backing it: `POST /v1/admin/blueprints/{id}/promote` stamps `promotedAt`/`promotedToJourneyId` and disables the blueprint in one update. A promoted blueprint is now frozen — `PATCH` and `enable` both refuse it (409), closing a gap where a promoted blueprint's graph could previously still be edited or re-enabled out from under the generated code.
