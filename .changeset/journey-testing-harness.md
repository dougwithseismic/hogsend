---
"@hogsend/core": minor
"@hogsend/engine": minor
"@hogsend/testing": minor
"create-hogsend": minor
---

Add a deterministic, zero-infrastructure journey test harness with virtual time,
scripted events and state, captured effects, scenario tables, and optional
Vitest mailbox matchers. Expose journey run functions, share production schedule
and enrollment semantics, and include a tested scaffold example. Journey email
and SMS history now excludes attempts that never reached a provider. pnpm-based
scaffolds pin the repository-supported pnpm 11 toolchain so clean-consumer
verification uses the same package manager locally, in CI, and in Docker.
