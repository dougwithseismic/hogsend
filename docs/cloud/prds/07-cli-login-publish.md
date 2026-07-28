# PRD 07 — CLI: login + publish (scoped; flesh out when popped)

## Scope
`hogsend login` — device-code flow against apps/cloud (`/api/cli/device` endpoints:
code mint, poll, approve page in dashboard); credentials stored `~/.hogsend/
credentials.json` (0600, per-cloud-host entries); `hogsend whoami`, `hogsend logout`.
`hogsend publish [--env <name>]` — tarball the scaffold (respect .gitignore, always
exclude `.env*`, `node_modules`, `dist`), attach manifest (app name, engine version from
lockfile, entry points, client-migration presence), upload to a publish endpoint, stream
build/deploy status back to the terminal (poll or SSE), exit nonzero on failed build.
`hogsend open` — dashboard deep link. All in `packages/cli` (TS); config precedence rules
already in `src/lib/config.ts` extended, not replaced — existing operate-an-instance
commands unchanged.

Key invariants: publish refuses a dirty engine-version mismatch vs the target stack unless
`--allow-upgrade`; tarball never contains secrets (test asserts); device flow tokens are
short-lived + revocable from dashboard (Settings → CLI sessions).

_Boundary:_ `packages/cli` + `apps/cloud` (endpoints). _Depends:_ PRD 03, PRD 08 (build
intake; publish can land dry-run first against a stub intake).

## Implementation Notes
