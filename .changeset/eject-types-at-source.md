---
"@hogsend/cli": patch
---

`hogsend eject` repoints a vendored package's `types` (top-level and per-export condition) from emitted `./dist/**.d.ts` to the matching `./src` entry. `dist` is never vendored and the ejected source is what you edit, so an ejected `@hogsend/engine` type-checks against its live source.
