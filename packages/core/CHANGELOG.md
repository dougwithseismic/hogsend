# @hogsend/core

## 0.1.0

### Minor Changes

- 94a0bd4: Timezone-aware scheduling, send windows, and per-recipient frequency capping.

  - **`createHogsendClient({ defaults })`** — new `defaults.timezone` (global fallback IANA tz), `defaults.sendWindow` (quiet-hours window auto-applied by `ctx.when`), and `defaults.frequencyCap` (per-recipient send cap enforced in the mailer; "transactional" exempt by default).
  - **`ctx.when(...)`** on the journey context — resolves a send instant in the recipient's timezone and snaps it inside the configured send window.
  - **Timezone resolution** — new `resolveTimezone` / `resolveTimezoneWithSource` / `setContactTimezone` (`@hogsend/engine`) with a precedence chain (explicit → PostHog person props → `contacts.timezone` cache → global default), plus explicit-tz validation.
  - **`@hogsend/core/schedule`** — new public schedule module (window/time/tz resolvers).
  - **`isFrequencyCapped`** + `FrequencyCapConfig` / `FrequencyCapWindow` exports.

  Includes additive migration `0009` (expand-only): a nullable `contacts.timezone` column and an `email_sends` frequency-cap index. **After upgrading, run `db:migrate`** — the boot guard reports `schema.engine.inSync` until applied. No backfill required (the tz column is an opportunistic cache below PostHog/properties in precedence).

### Patch Changes

- Updated dependencies [94a0bd4]
  - @hogsend/db@0.1.0
