# PRD 02 — Two release gates: no silent `catch`, and a real tarball load proof

## Goal

Close the two mechanical holes that let `#611` publish green three times:
an error was swallowed by a commented, confidently-wrong `catch`, and nothing
ever proved a published package's declared entries were in its tarball AND
loadable once installed. In `#611` the entry WAS inside the tarball — a raw
`./src/index.ts` npm packed happily and Node refused to load under
`node_modules` — so presence alone is not the gate; the load proof is.

## Locked decisions (inherits DECISIONS.md §3)

- `release-doctor` stays static and build-free; the packing gate is its own
  script — unconditional in ci.yml's Release-integrity job, publish-phase-
  guarded in release.yml (§3e as amended; a phase guard is not change
  detection).
- The `catch` rule is calibrated against a real offender count BEFORE any source
  is annotated; the core flags any catch that discards its error binding, and
  the only exemption is a structured `// hogsend:allow-swallow <reason>` marker
  — a plain comment exempts nothing, because the `#611` catches were commented
  and wrong (§3f as amended).

## Acceptance criteria (EARS)

1. WHEN `pnpm release-doctor` runs against a source tree containing a `catch`
   block that discards its error binding (empty body, or a body that never uses
   the error) with no log, no rethrow and no `hogsend:allow-swallow` marker,
   the check SHALL fail and name the offending file and line — a plain
   explanatory comment SHALL NOT exempt it.
2. WHEN a `catch` block logs its error, rethrows, or carries a
   `// hogsend:allow-swallow <reason>` marker, the check SHALL NOT flag it.
3. WHEN `pnpm release-doctor` runs against the repository as shipped, every
   check SHALL pass — the gate is introduced green.
4. WHEN `pnpm verify-tarballs` runs, it SHALL pack every publishable engine-line
   package (disk-derived, the same source `release-doctor` uses — never a
   hand-maintained list).
5. WHEN any declared entry of a packed package — every string leaf of
   `exports["."]` across all conditions, `main`, and every `bin` target — is
   absent from its tarball file set, `verify-tarballs` SHALL fail and name the
   package and the missing path.
6. WHEN a package declares a `types` entry that is absent from its tarball,
   `verify-tarballs` SHALL fail and name it; WHEN a package declares no `types`
   entry (`hogsend`, `@hogsend/studio`), the types assertion SHALL be skipped,
   not failed.
7. WHEN ANY of a package's checked entries lives under `dist/`, `verify-tarballs`
   SHALL build that package before packing rather than reporting a false
   absence — this includes `@hogsend/cli` and `@hogsend/mcp`, whose `.` export
   is raw `src/` but whose executables are `bin: ./dist/bin.js`.
8. WHEN `verify-tarballs` succeeds, it SHALL print the number of packages
   verified — a bare success line is not evidence (DECISIONS §5).
9. WHEN CI runs, `verify-tarballs` SHALL execute unconditionally in ci.yml's
   Release-integrity job, and in release.yml only in the publish phase
   (`if: steps.phase.outputs.publish == 'true'`, after the build steps) — never
   behind a change-detection skip.
10. WHEN a dist-resident runtime entry is present in the tarball but fails to
    `import()` under plain node from a temp-dir install of the real tarball
    (the `#611` mode: raw `.ts` entry, devDependency-only import, missing
    chunk), `verify-tarballs` SHALL fail and name the package.
11. WHEN a package declares only `bin` entries (the bare `hogsend` alias: no
    `exports`, no `main`, no `types`), `verify-tarballs` SHALL assert each
    `bin` target's presence rather than crashing or vacuously passing on an
    undefined runtime entry.
12. WHEN `pack-tarballs.sh` builds packages before packing, it SHALL consume
    the dist-shipping list derived by `verify-tarball-entries.mjs` — one
    derivation, both gates, no second hand-synced build list.

## Tasks

### T1 — the `catch` gate scanner, calibrated

Add a check to `scripts/release-doctor.mjs` that scans first-party TypeScript
sources (`packages/*/src`, `apps/*/src`; exclude `dist`, `node_modules`,
`template/`, generated files) for error-discarding `catch` blocks.

**Calibrate before enforcing.** Implement the scanner, run it, and REPORT the
offender count. The non-negotiable core (§3f as amended) is any `catch` that
discards its error binding — empty body OR a non-empty body that never uses the
error — because the three catches that shipped `#611` were non-empty
(`createPostmarkProvider = null;`) with confident, WRONG comments; an
empty-body-only rule passes them verbatim, and a comment exemption whitelists
them. The only exemption is the structured `// hogsend:allow-swallow <reason>`
marker. Widen beyond the core only as far as the offender list stays small
enough to fix honestly; if widening produces a large list, tighten the rule
instead of annotating the repository to fit it. State in the report which rule
was chosen and why.

Fix (or mark with `hogsend:allow-swallow`, where swallowing is genuinely
correct) whatever the chosen rule flags, so the check is introduced green.
Mutation-check the rule against the pre-fix `#611` shape: a copy of the old
`} catch { /* comment */ createX = null; }` body must be flagged.

_Boundary:_ `scripts/` + whatever sources the chosen rule legitimately flags ·
_Depends:_ —

### T2 — `verify-tarballs`

Create `scripts/verify-tarball-entries.mjs`, wired as `pnpm verify-tarballs`:

- Derive the package list from disk exactly as `release-doctor`'s
  `enginePackagesFromDisk()` does — publishable `@hogsend/*` plus the bare
  `hogsend` alias. Extract or mirror that logic; do not hand-maintain a list.
- Collect ALL declared entries per package: every string leaf of `exports["."]`
  across all conditions (`@hogsend/client`/`js`/`react`/`video` have no
  `default` — only `types`/`import`/`require`, so a default-only rule skips
  their ESM entry), `main`, every `bin` target, and dist-pointing export
  subpaths (e.g. cli's `"./bin"`). `types` is checked only when declared —
  `hogsend` and `@hogsend/studio` declare none; the field's absence is not a
  failure. Bin-only packages (the `hogsend` alias) are checked via their `bin`
  targets — the entry set must never resolve to `undefined`.
- Build every package where ANY collected entry lives under `dist/` (includes
  `@hogsend/cli` and `@hogsend/mcp` via their bins), via
  `pnpm exec turbo run build --filter=<derived pkgs> --concurrency=2` — turbo,
  not the pack-tarballs.sh `pnpm --filter build` form, which bypasses the Turbo
  cache (§3e as amended).
- Expose the derived dist-shipping list (e.g. a `--list-dist-packages` mode)
  for consumption by other scripts (T6).
- Pack with `npm pack --dry-run --json` and assert every collected entry
  appears in the file set. Verified output contract: a JSON array whose
  `[0].files[].path` values are package-root-relative with no `package/`
  prefix (e.g. `dist/index.js`), stderr-clean, and `workspace:^` deps are
  harmless verbatim — this is dry-run file enumeration only, never a publish
  artifact.
- Report every offender, not just the first. Print the count of packages
  verified on success.

**Prove the gate works by mutation** (DECISIONS §5) — TWO protocols, because
npm AND pnpm force-include an existing `bin` target regardless of the `files`
allowlist (verified in-repo), so a `files` mutation can never redden a bin
check:

- main/exports leg: temporarily remove `dist` from a dist-shipping plugin's
  `files`, confirm red naming that package, restore, confirm green (npm does
  NOT auto-include the `main` file — verified in-repo).
- bin leg: mutate by skipping the package's build or pointing `bin` at a
  nonexistent path — npm packs silently with an absent bin target, the exact
  `#611` class — confirm red, restore, confirm green.

A gate that has never been seen to fail is not a gate. Report all outputs.

_Boundary:_ `scripts/` + `package.json` scripts · _Depends:_ —

### T3 — wire into CI

Add `pnpm verify-tarballs` to ci.yml's Release-integrity job (after
`release-doctor`), unconditional — no `if:` change-detection guard. In
release.yml add it AFTER the build steps, guarded
`if: steps.phase.outputs.publish == 'true'` (§3e as amended): Phase A (the
common main push) publishes nothing and the same SHA already ran the gate in
ci.yml — unguarded it would re-add ~1–2 min of cold builds plus ~23 packs to
every main push while gating nothing. Do not describe the ci.yml build as a
cache hit: Release-integrity runs in parallel with the quality job, so
PR-touched packages are cold; budget the honest cost.

_Boundary:_ `.github/workflows` · _Depends:_ T2, T5

### T4 — changeset

Add the changeset for this wave and run `pnpm release-doctor --fix-changeset` if
any engine-line package was touched (PRD 01 touches `@hogsend/engine` and
`@hogsend/cli`, so it will be).

_Boundary:_ `.changeset/` · _Depends:_ PRD 01 complete, T3, T6

### T5 — the install-and-import load proof

Presence in the tarball is not the `#611` mode — the pre-fix plugin's raw
`./src/index.ts` entry WAS packed and Node refused to load it under
`node_modules`. For every package with a dist-resident checked runtime entry:
pack for REAL (not dry-run), install the tarball into a temp dir, and
`import()` the runtime entry (and each `bin` target) under plain `node` —
never tsx, which masks exactly this failure. This generalizes
`verify-scaffold.sh` step 7b from apollo-only to all dist-shipping packages and
also catches present-but-broken modes: an entry importing a devDependency-only
package, or a missing chunk file. Raw-`.ts`-by-design packages (engine/core/db,
bundled by consumers via tsup `noExternal`) keep the presence assertion only.

Mutation proof: point a package's runtime entry at a raw `.ts` file (the
pre-fix apollo shape — expect `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`),
confirm red, restore, confirm green. Report both outputs.

_Boundary:_ `scripts/` · _Depends:_ T2

### T6 — one build-list derivation for both gates

`pack-tarballs.sh` keeps a hard-coded 6-package build list its own header
admits must be hand-synced; once T2's disk-derived set exists, a new
dist-shipping package would pass `verify-tarballs` yet ship an empty tarball
into the scaffold smoke because `pack-tarballs.sh` never built it — two gates
disagreeing. Change `packages/create-hogsend/scripts/pack-tarballs.sh` to
consume `verify-tarball-entries.mjs --list-dist-packages` for its build step,
replacing the hard-coded invocation (AC12). When the scaffold smoke runs on
package-touching PRs, verify-tarballs' build warms the same work.

_Boundary:_ `scripts/` + `packages/create-hogsend/scripts/` · _Depends:_ T2

## Seams

None.

## Done when

All 12 criteria hold, `pnpm release-doctor` and `pnpm verify-tarballs` are both
green on the shipped tree, and the T1/T2/T5 mutation proofs are each reported
with both the red and green outputs.

## Implementation Notes
