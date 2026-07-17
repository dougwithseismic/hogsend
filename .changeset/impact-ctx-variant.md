---
"@hogsend/engine": minor
"@hogsend/testing": minor
"@hogsend/cli": patch
---

Add `ctx.variant(key, arms)` — a deterministic, recorded, equal-split A/B
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
