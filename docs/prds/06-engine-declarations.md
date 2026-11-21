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

Shipped in #684 (squash `e786d310`), to be published as `@hogsend/engine@0.68.0` when Version Packages #685 is merged.

- `packages/engine/tsconfig.build.json` emits 350 declaration files (3.3 MB)
  in ~22 s with zero errors. `build` and `prepack` both run it.
- Every engine export is `{ "@hogsend/source": src, types: dist, default: src }`;
  `customConditions: ["@hogsend/source"]` in `@repo/typescript-config/base.json`
  keeps the monorepo on live source with no build step.
- Scaffold `check-types` (packed tarballs, `verify-scaffold.sh`): **OOM after
  37 s at 4 GB → passes in 6 s** (tsc total 3.7 s, check 2.0 s, 642 MB, 2,183
  files). An unknown template key still errors (`keyof TemplateRegistryMap`),
  pinned by the new step `[5b]` negative test.
- `release-doctor` gained a 19th invariant: a package whose `types` points at
  `dist` must publish `dist` and have a script that emits it.
- `@hogsend/cli` eject repoints `types` at source, since `dist` is not
  vendored.
- `@hono/zod-openapi` stays pinned at `1.4.0` (the #657 workaround) — no longer
  load-bearing for consumers, kept to avoid an unrelated upgrade in this PRD.
- Production check: pending the npm publish. Then: `npm view @hogsend/engine@latest types` → `./dist/index.d.ts`, and a fresh `pnpm dlx create-hogsend@latest` → install → `check-types` → boot → `/v1/health` 200.
