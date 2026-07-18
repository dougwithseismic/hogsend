# @hogsend/testing

## 0.47.0

### Minor Changes

- 5cbec50: Add `ctx.variant(key, arms)` — a deterministic, recorded, equal-split A/B
  primitive for journeys. Assignment is a pure sha256 bucket over
  `variant:<journeyId>:<key>:<userId>` (no RNG, no clock — replay-law safe;
  statistically independent of holdout assignment), recorded once per enrollment
  under the reserved `journey_states.context.__variants__` bag and replayed
  VERBATIM within that enrollment even across deploys that change the arms
  array. Zero durable Hatchet calls. Keys are STRICTLY validated against
  `/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/` (1-64 chars, no `:`, no spaces); arms
  are validated only on fresh assignment (an in-flight enrollment with a
  recorded arm never crashes on a later malformed deploy). The engine now strips
  all four reserved namespace keys (`__once__`, `__digest__`, `__throttle__`,
  `__variants__`) from trigger-event properties before seeding journey context,
  so a publishable-key event can never pre-fill a reserved bag. The journey test
  harness gains matching `ctx.variant` support plus a
  `variants: Record<string, string>` seed option.
- 0c1852c: Add a deterministic, zero-infrastructure journey test harness with virtual time,
  scripted events and state, captured effects, scenario tables, and optional
  Vitest mailbox matchers. Expose journey run functions, share production schedule
  and enrollment semantics, and include a tested scaffold example. Journey email
  and SMS history now excludes attempts that never reached a provider. pnpm-based
  scaffolds pin the repository-supported pnpm 11 toolchain so clean-consumer
  verification uses the same package manager locally, in CI, and in Docker.

### Patch Changes

- Updated dependencies [2e9e20b]
- Updated dependencies [2e9e20b]
- Updated dependencies [5cbec50]
- Updated dependencies [5cbec50]
- Updated dependencies [dc6a13d]
- Updated dependencies [0c1852c]
- Updated dependencies [0c1852c]
  - @hogsend/email@0.47.0
  - @hogsend/sms@0.47.0
  - @hogsend/core@0.47.0
  - @hogsend/engine@0.47.0
