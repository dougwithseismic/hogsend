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

## CONFIRMED against the PUBLISHED package, and the severity is NARROWER than first stated

The first reproduction used a locally packed tarball, which only proves something about this working
tree. Redone properly with the real customer command:

```
pnpm dlx create-hogsend@latest customer-app --pm pnpm --no-git
cd customer-app && pnpm check-types
```

Installing `@hogsend/engine@0.63.0` **from npm**: the same 33 errors, same codes, same files, zero in
the customer's own source.

**But the app is NOT broken, and an earlier note here implied it was.** Measured on the same scaffold:

| Step | Result |
| --- | --- |
| scaffold | works |
| `pnpm install` | works |
| **`pnpm build`** | **works** — `dist/index.js` 3.59 MB, `dist/worker.js` 3.58 MB, success in 374ms |
| `pnpm check-types` | **fails, 33 errors, all inside `@hogsend/engine`** |

So this is a developer-experience defect, not a broken product: tsup bundles and the app runs. What it
costs is the customer's ability to use `check-types` at all — their own errors are buried under 33 of
ours, which makes the script worthless exactly when they need it.

## Root cause NOT yet identified. Five hypotheses falsified — do not re-run these.

Recorded so the next person starts from the frontier rather than the beginning.

| # | Hypothesis | Test | Result |
| --- | --- | --- | --- |
| 1 | Transitive version drift (`drizzle-orm`) | compared resolved versions | **FALSE** — both `0.45.2` |
| 2 | TypeScript version differs | compared both | **FALSE** — both `5.9.2` |
| 3 | `moduleResolution: Bundler` vs `NodeNext` | compiled engine under Bundler in-repo | **FALSE** — 0 errors |
| 4 | Missing `@types/pg` (present in the monorepo's drizzle peer set, absent in the customer's) | installed it in the scaffold | **FALSE** — still 33 |
| 5 | `types: ["node"]` narrowing in the template | removed it, re-ran | **FALSE** — still 33 |
| 6 | zod version skew / two copies | compared | **FALSE** — both resolve `4.4.3`, one copy each |
| 7 | `@hatchet-dev/typescript-sdk/v1` unresolvable without the engine's `paths` mapping | `require.resolve` from the scaffold | **FALSE** — resolves fine |

**PRD 12's original description deserves partial credit and this PRD's first draft was too dismissive
of it.** It called these "zod `.refine` inference errors". The error CODES are `TS7006`/`TS7053`, not
a zod-specific code, which is what prompted the correction — but several of the failures ARE inside
zod chains. `routes/admin/settings.ts:55` is `.transform((v) => v.toUpperCase())`, and `v` is the
implicit `any`. So the shape of the original diagnosis was closer than "no zod anywhere" allowed.
Eight of the thirteen `TS7006`s are single-letter callback parameters of exactly this kind.

What remains: zod's generic inference produces typed callback parameters when the engine compiles in
the monorepo and `any` when the SAME zod version compiles the SAME source inside a consumer install.
~~The difference is therefore in the module graph or the program shape, not in a version.~~

**SOLVED 2026-08-12, and that last sentence was wrong.** It IS a version — just not zod's, drizzle's
or TypeScript's, which is why four separate version comparisons all came back clean. The culprit is
the WRAPPER: `@hono/zod-openapi@1.5.2` ships broken declarations. Its `dist/index.d.mts` imports only
`{ ZodError, ZodType }` from zod (`z` dropped) and then says `import z = zodModule.z` where
`zodModule` is never declared, so `z` is `any` and every `z.object()` chain downstream is `any` too.

Two things this reconciles, worth recording so nobody re-derives them:

- **H6 (mismatched zod) was correctly falsified and still missed it.** zod really is identical — one
  copy, 4.4.3, same physical path from engine, app and wrapper alike. H6 tested the right idea at the
  wrong altitude: the break is one layer up, in the package that re-exports `z`.
- **The original "zod `.refine` inference" description was closer than "no zod anywhere" allowed.**
  `routes/admin/settings.ts:55` really is zod inference; the `z` just arrives through a wrapper. Both
  descriptions were half right, which is why each survived a check the other should have failed.

`skipLibCheck: true` is not merely unhelpful here — it ACTIVELY HIDES the error that names the cause.
Turn it off and the whole thing collapses to one line:
`@hono/zod-openapi@1.5.2/dist/index.d.mts(259,12): error TS2503: Cannot find namespace 'zodModule'.`

We are pinned to 1.4.0 by our lockfile alone; the engine declares `^1.4.0` and a fresh scaffold ships
no lockfile, so it floats to latest. `pnpm update` would break us identically. 1.4.0 is also the only
clean version that still carries the `types` export condition — 1.5.0 dropped it and never restored
it — which is why the pin is 1.4.0 rather than 1.5.1.

Follow-up, not folded into the fix: the scaffold smoke failed correctly throughout, but its output
read as "our source is wrong" rather than "a shipped dependency's types are wrong". Making it name
the offending package would have collapsed this investigation to minutes.

A reproduction is preserved at the path recorded in the session scratchpad
(`/tmp/hogsend-real-customer.*/customer-app`) — a real npm install, already failing, ready to bisect.

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
