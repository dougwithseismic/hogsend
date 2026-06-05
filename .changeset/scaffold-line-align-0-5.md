---
"@hogsend/db": minor
"@hogsend/email": minor
"@hogsend/studio": minor
---

Version-line alignment — no functional changes. Bumped to keep all
scaffold-pinned packages on the engine `0.5.x` minor line so the caret-pinned
(`^{{ENGINE_VERSION}}`) `create-hogsend` template resolves every `@hogsend/*`
dependency. (`@hogsend/email` also picks up a README refresh documenting that the
`EmailProvider` contract now lives in `@hogsend/core`.)
