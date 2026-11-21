---
"@hogsend/engine": patch
---

The engine now ships compiled type declarations (`dist/**/*.d.ts`) and points its `types` export condition at them, so a consumer's `tsc` reads the engine's public types instead of re-type-checking its ~87k lines of implementation source. A freshly scaffolded app's `pnpm check-types` previously ran out of memory (4 GB heap) inside `@hogsend/engine`; it now type-checks only the app's own code. Runtime resolution is unchanged (the `default` condition still points at `src/`, bundled by tsup `noExternal`), and inside this monorepo the `@hogsend/source` condition keeps editors and `tsc` on live source.
