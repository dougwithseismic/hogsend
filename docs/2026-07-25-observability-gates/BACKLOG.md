# BACKLOG — Observability & release gates

Post-mortem follow-up to `#611` (opt-in plugins silently inert for three
releases). Two independent improvements; no shared code, so either can ship
alone.

| # | PRD | Status | Depends on | Scope |
|---|-----|--------|-----------|-------|
| 01 | [Boot diagnostics are observable over the wire](prds/01-boot-diagnostics.md) | [ ] | — | Process-global collector recording at every detected-misconfiguration site (incl. the silent Twilio no-sender skip and person-reads-disabled); warning COUNT on `/v1/health` merged API+worker via the Redis heartbeat, detail on admin-authed `/v1/admin/config`; rendered by `hogsend doctor` with a double-gated admin-key send |
| 02 | [Two release gates](prds/02-release-gates.md) | [ ] | — | `release-doctor` discarded-error-binding `catch` check (structured `hogsend:allow-swallow` opt-out only) + new `pnpm verify-tarballs` asserting every declared entry (`exports["."]` leaves, `main`, `bin`, declared `types`) is in its tarball AND install-`import()`ing dist-resident entries under plain node |

## Status legend

- `[ ]` not started
- `[~]` shipped to a seam (external dependency enumerated)
- `[x]` complete

## Wave notes

- PRD 02's T4 (changeset) runs last because it must cover both PRDs' touched
  packages.
- No release in this wave. The changeset rides the next train.
