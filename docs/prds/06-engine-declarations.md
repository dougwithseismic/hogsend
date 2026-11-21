# PRD 06 — Ship compiled engine type declarations

## Goal

A freshly scaffolded app's `pnpm check-types` must check the user's code, fast,
and never fail inside `@hogsend/engine`. Today the engine ships raw `.ts` as its
`types` entry, so every consumer's `tsc` re-type-checks the engine's whole
implementation (~87k lines) under the consumer's config and the consumer's
resolved dependency versions.

Measured on `main` (2026-11-21, `verify-scaffold.sh` against packed tarballs):
the scaffold's `check-types` **runs out of memory** (V8 4 GB heap, 37 s) before
reporting anything. Issue #657 recorded the earlier symptom (33 implicit-any
errors inside the engine from `@hono/zod-openapi@1.5.2`), worked around by
pinning `@hono/zod-openapi` to exactly `1.4.0`.

## Locked decisions

- Emit declarations with plain `tsc -p tsconfig.build.json`
  (`emitDeclarationOnly`, declaration maps, tests excluded) into `dist/`.
- `exports[*].types` → `./dist/**.d.ts`; `exports[*].default` stays `./src/**.ts`
  (consumers keep bundling source via tsup `noExternal`; runtime unchanged).
- In-repo, a custom export condition `@hogsend/source` (set once in
  `@repo/typescript-config/base.json` `customConditions`) keeps editors and
  `tsc` on live source, so the monorepo dev loop does not depend on a build.
- `prepack` emits the declarations, so `pnpm pack`/`publish` can't ship without
  them; `release-doctor` asserts `dist` is in `files` for any package whose
  `types` points at `dist`.
- Template `tsconfig.json` is NOT loosened (the constraint from #657).

## Acceptance criteria

- WHEN a fresh app is scaffolded from packed tarballs THEN `pnpm check-types`
  SHALL exit 0 without raising the Node heap limit.
- WHEN a consumer passes an unknown template key to `sendEmail` THEN `tsc` SHALL
  still error (augmentable registries keep working through the declarations).
- WHEN the engine tarball is packed THEN it SHALL contain `dist/index.d.ts`.
- WHEN the monorepo runs `turbo run check-types` / `pnpm test` THEN results SHALL
  match the pre-change baseline.

## Tasks

1. `packages/engine/tsconfig.build.json`, `build` + `prepack` scripts, exports
   conditions, `files` += `dist`.
2. `customConditions: ["@hogsend/source"]` in the shared base tsconfig.
3. `release-doctor` declaration guard; `verify-scaffold.sh` tarball assertion.
4. Changeset (engine patch + uniform-line companion).

## Implementation Notes

_Filled in after shipping._
