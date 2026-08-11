# PRD 23 — A fresh scaffold does not type-check, and the errors are ours

**Status:** `[ ]` · **Depends:** 12 · **Boundary:** `packages/engine`, `packages/create-hogsend`

## Goal

`pnpm dlx create-hogsend@latest` is the product's front door. Today the app it produces fails
`pnpm check-types` with **33 errors, every one of them inside `@hogsend/engine`**. Fix that, and make
the scaffold smoke prove it stays fixed.

## What PRD 12's seam said, and what is actually true

The seam recorded "33 zod `.refine` inference errors". The count is right and **the diagnosis is
wrong** — there is no zod in it. Reproduced 2026-08-11 by running
`pnpm --filter create-hogsend verify`:

| Code | Count | Meaning |
| --- | --- | --- |
| `TS7053` | 19 | indexing a type with an `any` expression |
| `TS7006` | 13 | parameter implicitly `any` |
| `TS2366` | 1 | function lacks ending return statement |

**All 33 are inside `node_modules/.../@hogsend/engine/src/`** — `routes/admin/emails.ts`,
`routes/admin/metrics.ts`, `routes/admin/links.ts`, `routes/admin/settings.ts`,
`routes/campaigns/index.ts`, `routes/feed/index.ts`, `routes/admin/reporting.ts`. Zero errors in the
consumer's own code.

## The mechanism, and why `skipLibCheck` cannot save us

`@hogsend/engine` **ships raw TypeScript**:

```json
"main": "./src/index.ts",
"types": "./src/index.ts",
"files": ["src", "README.md"]
```

That is deliberate — consumers bundle it via tsup `noExternal` — and it has a consequence nobody wrote
down: **every consumer type-checks our IMPLEMENTATION, not our declarations.** `skipLibCheck: true`,
which the template sets, only skips `.d.ts` files. A package that ships `.ts` is outside its reach,
and `exclude: ["node_modules"]` does not help either, because `exclude` only decides ROOT files while
tsc still follows the imports.

So the engine's source is compiled under whatever config and dependency graph the customer has.

## What has been ruled OUT, by experiment

- **Not a strictness difference.** The engine's base config and the template's are identical on
  `strict`, `noUncheckedIndexedAccess`, `noImplicitAny` and `skipLibCheck`.
- **Not `moduleResolution`.** The only meaningful config difference is engine `NodeNext` vs template
  `Bundler`. Compiling the engine from inside the monorepo with `moduleResolution: Bundler`,
  `module: ESNext` and `verbatimModuleSyntax: true` produces **0 errors**. Resolution MODE is not the
  cause.

That leaves what the engine's imports RESOLVE TO inside a consumer install.

## Leading hypothesis (NOT yet confirmed — say so until it is)

A transitive dependency resolves to a different version in a fresh consumer install than the
monorepo's lockfile pins, turning some types into `any` and cascading into `TS7006`/`TS7053`.

`drizzle-orm` is the prime suspect on three counts: the engine declares it as the RANGE `^0.45.2`, so
a fresh install may take a newer minor; **116 engine source files import it**; and the failing types
named in the errors are its own (`PgColumn<…>`, `SQL<unknown>`).

This would also explain PRD 12's CI-vs-local puzzle without anything being flaky: two installs at
different times resolve different versions, and pnpm 11's release-age quarantine adds a second way for
the two to disagree.

**The next experiment is one command:** re-run `verify-scaffold.sh` with its `trap cleanup EXIT`
disabled and compare the scaffolded app's resolved `drizzle-orm` against the monorepo's. Confirm
before fixing.

## Locked decisions

- **Do NOT fix this by loosening the template's tsconfig.** Turning off `strict` in the scaffold to
  hide errors in our package would ship every customer a weaker type-check to spare us a bug.
- **Our shipped source must type-check under a reasonable consumer config.** Whatever the resolution
  turns out to be — pinning the range, fixing the annotations, or shipping declarations — the standard
  is that a fresh scaffold is green.
- **The scaffold smoke must FAIL when this regresses.** It does today, and that is the one good news
  here: the check works, its result was misread.

## Acceptance criteria (EARS)

- WHEN a fresh scaffold is created and `pnpm check-types` is run, it SHALL report zero errors.
- WHEN an engine dependency resolves to a version whose types differ, the scaffold smoke SHALL fail
  rather than pass, and its output SHALL name the package.
- WHEN the engine ships source, the scaffold smoke SHALL be treated as the check that our source
  compiles for consumers, and that intent SHALL be stated in the script.

## Tasks

1. **Confirm the hypothesis.** Disable the cleanup trap, capture the scaffolded app's resolved
   dependency versions, diff against the monorepo's.
   _Boundary:_ none · _Depends:_ none
2. **Fix the root cause** as the evidence dictates.
   _Boundary:_ `packages/engine` · _Depends:_ task 1
3. **Make the failure legible.** The smoke currently prints 33 raw tsc lines; it should say plainly
   that the errors are in a shipped dependency and what that means.
   _Boundary:_ `packages/create-hogsend` · _Depends:_ task 2

## Seams

- None. Everything here is reproducible locally.

## Done when

A fresh scaffold type-checks clean, and the smoke that proves it explains what it is proving.

## Implementation Notes
