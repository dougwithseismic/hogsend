---
"create-hogsend": minor
"@hogsend/cli": minor
"@hogsend/engine": minor
"@hogsend/attribution": minor
"@hogsend/client": minor
"@hogsend/core": minor
"@hogsend/db": minor
"@hogsend/email": minor
"hogsend": minor
"@hogsend/js": minor
"@hogsend/mcp": minor
"@hogsend/plugin-discord": minor
"@hogsend/plugin-meta-capi": minor
"@hogsend/plugin-posthog": minor
"@hogsend/plugin-postmark": minor
"@hogsend/plugin-resend": minor
"@hogsend/plugin-telegram": minor
"@hogsend/plugin-twilio": minor
"@hogsend/react": minor
"@hogsend/sms": minor
"@hogsend/studio": minor
---

Agent-drivable scaffolding: the whole scaffold → bootstrap → run path now works with zero prompts.

- **Fixed: the env-driven first admin actually works.** The scaffolded `src/index.ts` now calls `bootstrapAdminFromEnv` — bootstrap, `env.example`, and the CLI skill all documented that setting `STUDIO_ADMIN_EMAIL` mints the first admin on boot, but the template never wired the call, so it silently minted nothing. **Apps scaffolded before this version:** add `bootstrapAdminFromEnv` to your `@hogsend/engine` import in `src/index.ts` and call `await bootstrapAdminFromEnv({ client });` right before `bootstrapApiKeyFromEnv` to activate the documented path.
- **New scaffold flags:** `--admin-email` / `--admin-password` preset the first Studio admin (written into `env.example`; minted on first boot; password validated ≥ 8 chars at scaffold time so an invalid value can't brick boot), and `--posthog` expresses keyless PostHog intent headlessly (the twin of ticking PostHog in the interactive multiselect — surfaces the connect step + hints, writes no env values).
- **Agent runbook:** every scaffold's `CLAUDE.md` gains a "Zero to running (headless / agents)" section (bootstrap exit-code contract, first-admin semantics, background + `GET /v1/health` polling pattern, `--json` ops, PostHog without a browser via `POSTHOG_PERSONAL_API_KEY`); same runbook in the `hogsend-cli` skill's `setup-local` reference; docs get an agent quickstart.
- **Verification:** the scaffold harness now asserts the admin boot-mint wire-up, the new flags' env writes, and flag-validation failures; a new `verify-headless.sh` E2E (nightly + on-demand `headless-e2e` workflow) proves the entire zero-TTY path against a real stack — bootstrap exit 0 → boot → healthy → the preset admin signs in → the minted admin key drives the CLI.

(The whole engine line rides to keep versions uniform; this release also carries the previously-stranded bootstrap busy-port fix for create-hogsend.)
