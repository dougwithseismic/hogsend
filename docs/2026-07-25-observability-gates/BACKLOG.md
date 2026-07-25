# BACKLOG — Observability & release gates

Post-mortem follow-up to `#611` (opt-in plugins silently inert for three
releases). Two independent improvements; no shared code, so either can ship
alone.

| # | PRD | Status | Depends on | Scope |
|---|-----|--------|-----------|-------|
| 01 | [Boot diagnostics are observable over the wire](prds/01-boot-diagnostics.md) | [~] | — | Process-global collector recording at every detected-misconfiguration site (incl. the silent Twilio no-sender skip and person-reads-disabled); warning COUNT on `/v1/health` merged API+worker via the Redis heartbeat, detail on admin-authed `/v1/admin/config`; rendered by `hogsend doctor` with a double-gated admin-key send |
| 02 | [Two release gates](prds/02-release-gates.md) | [ ] | — | `release-doctor` discarded-error-binding `catch` check (structured `hogsend:allow-swallow` opt-out only) + new `pnpm verify-tarballs` asserting every declared entry (`exports["."]` leaves, `main`, `bin`, declared `types`) is in its tarball AND install-`import()`ing dist-resident entries under plain node |

## Progress (2026-07-25)

PRD 01 is code-complete (T1–T5, T7 shipped); only T6 (docs) is outstanding.
PRD 02 T1 shipped; T2/T5/T6/T3/T4 are not started.

| Commit | Task |
|---|---|
| `5e2fd92f` | 01/T1 collector |
| `0c507995` | 01/T2 recording sites |
| `699048da` | 01/T3+T4 health count + admin route |
| `26b70931` | 01/T7 worker diagnostics over the heartbeat |
| `8f302f18` | 01/T5 doctor rendering + key-leak gating |
| `24e9b00a` | 02/T1 dynamic-import catch gate |

**Resume at PRD 02 / T2 + T5** (`scripts/verify-tarball-entries.mjs`). Not
started — nothing was written. The load proof is the load-bearing half: the
pre-fix `#611` entry WAS in its tarball, so a presence-only check passes the
bug. Then 02/T6 (`pack-tarballs.sh` consumes `--list-dist-packages`), 02/T3 (CI
wiring), 01/T6 (docs), 02/T4 (changeset refresh).

## Status legend

- `[ ]` not started
- `[~]` shipped to a seam (external dependency enumerated)
- `[x]` complete

## Wave notes

- PRD 02's T4 (changeset) runs last because it must cover both PRDs' touched
  packages.
- No release in this wave. The changeset rides the next train.
