---
"create-hogsend": patch
---

A scaffolded app's `src/index.ts` now calls the engine's `reportApiReady`, so a fresh `create-hogsend` app gets the branded boot banner out of the box. This depends on the engine pinned by `ENGINE_VERSION` exporting `reportApiReady` — keep `ENGINE_VERSION` aligned with the engine minor that ships it in the Version PR (see the `release` skill).
