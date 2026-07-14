# @hogsend/attribution

## 0.45.0

### Minor Changes

- 314a7e6: Engine version line 0.45.0 — first-run reliability release. Rides the line with the fresh-scaffold fixes (spaced-path engine migrations, pnpm 11 install settings, honest bootstrap with admin-key mint + in-flow PostHog connect, inert email boot, stored-credential PostHog activation).

### Patch Changes

- Updated dependencies [314a7e6]
  - @hogsend/core@0.45.0

## 0.44.0

### Minor Changes

- b4669d8: `@hogsend/attribution` — the multi-model attribution engine (the piece the deals-for-leads shops don't have). Eight pure-function credit models over the contact's touchpoint path: first / last / last-non-direct (skips the form-submit goal line) / linear / time-decay (7d half-life default) / position-U (40-20-40) / position-W (first + lead + last anchors) / blended (mean of linear + time-decay + U). When a conversion point fires, the engine reads the touchpoint path inside the definition's `attributionWindowDays` (default 90) and persists EVERY model's allocation into the new `attribution_credits` ledger (weights sum to 1 per model; value = weight × conversion value, per currency; idempotent on (conversion, model, touchpoint)) — switching the reporting model is a WHERE clause, never a historical re-derivation. New `GET /v1/admin/attribution` serves the model × channel × currency rollup, and the Studio revenue dashboard gains an **Attribution** tab: per-channel credited revenue under a model picker plus the full model-comparison matrix — same conversions, eight opinions about who earned them.

### Patch Changes

- Updated dependencies [a2b49fd]
- Updated dependencies [0a1e2b7]
- Updated dependencies [55f7439]
- Updated dependencies [5949f25]
- Updated dependencies [820cceb]
- Updated dependencies [13dfcba]
  - @hogsend/core@0.44.0
