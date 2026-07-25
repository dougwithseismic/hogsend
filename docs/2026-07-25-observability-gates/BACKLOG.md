# BACKLOG — Observability & release gates

Post-mortem follow-up to `#611` (opt-in plugins silently inert for three
releases). Two independent improvements; no shared code, so either can ship
alone.

| # | PRD | Status | Depends on | Scope |
|---|-----|--------|-----------|-------|
| 01 | [Boot diagnostics are observable over the wire](prds/01-boot-diagnostics.md) | [~] | — | Process-global collector recording at every detected-misconfiguration site (incl. the silent Twilio no-sender skip and person-reads-disabled); warning COUNT on `/v1/health` merged API+worker via the Redis heartbeat, detail on admin-authed `/v1/admin/config`; rendered by `hogsend doctor` with a double-gated admin-key send |
| 02 | [Two release gates](prds/02-release-gates.md) | [x] | — | `release-doctor` discarded-error-binding `catch` check (structured `hogsend:allow-swallow` opt-out only) shipped. The generalized tarball verifier (T2/T5) was **descoped to a lean load proof** — see the decision note below — after verifying the #611 class is already guarded three ways |

## Progress (2026-07-25)

Both PRDs complete. PRD 02's generalized tarball verifier (T2/T5/T6/T3) was
descoped to a lean load proof — see the decision note below.

| Commit | Task |
|---|---|
| `5e2fd92f` | 01/T1 collector |
| `0c507995` | 01/T2 recording sites |
| `699048da` | 01/T3+T4 health count + admin route |
| `26b70931` | 01/T7 worker diagnostics over the heartbeat |
| `8f302f18` | 01/T5 doctor rendering + key-leak gating |
| `24e9b00a` | 02/T1 dynamic-import catch gate |
| `debda8f1` | 02/T5 (lean) load-prove postmark + twilio in verify-scaffold 7b |

### Decision — descope the generalized tarball verifier (2026-07-25)

The originally-spec'd `scripts/verify-tarball-entries.mjs` (T2/T5) plus its CI
wiring (T3) and `pack-tarballs.sh` list-consumption (T6) were **not built**. We
first verified whether the #611 class is a live gap: it is not. It is guarded
three ways —

1. the fix itself: opt-in plugins ship built `dist/` (0.55.0);
2. `release-doctor`'s static check *"engine opt-in plugins ship a loadable dist
   (runtime entry is built JS, not raw .ts)"* — fails on any regression to a raw
   `.ts` entry or a `files` that omits `dist`;
3. `verify-scaffold.sh` step 7b — a real `import()` of each opt-in plugin under
   plain `node` from a scaffolded app.

The only true gap was that 7b load-proved **apollo only**; postmark and twilio
(the other two opt-in plugins, structurally identical) were never load-proved in
CI. `debda8f1` closes exactly that — the lean, proportionate fix — and it is
mutation-verified: a raw-`.ts` entry under `node_modules` yields
`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, failing 7b; a built `.js` entry
loads clean.

A generalized verifier over EVERY dist package (js/react/video/mcp/studio) would
guard a purely theoretical gap at the cost of ~200 lines with source-masking
parsers, real temp-installs, and React-peer false-positive edge cases. Deferred
as not worth the surface area until a concrete bug motivates it.

## Status legend

- `[ ]` not started
- `[~]` shipped to a seam (external dependency enumerated)
- `[x]` complete

## Wave notes

- PRD 02's T4 (changeset) runs last because it must cover both PRDs' touched
  packages.
- No release in this wave. The changeset rides the next train.
