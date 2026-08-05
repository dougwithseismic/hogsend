# PRD 16 — Self-healing `hogsend publish`

## Scope
Make the two commands the scaffold outro already prints (`hogsend login &&
hogsend publish`) collapse to one. `hogsend publish` with no session offers the
auth flow inline (interactive: choose device flow or email OTP, run it, then
continue the publish in the same invocation; non-TTY/`--json`: refuse with the
exact command to run — never block headless on a hidden prompt). `hogsend
publish` against an environment whose stack is `deferred`/provisioning renders
the provisioning phases from the build status feed (PRD 15) with the same
polling loop it already has for builds — one continuous progress narrative from
"provisioning your stack" through "deploying".

Also: `hogsend whoami`/`publish` refusals for a revoked/expired session offer
the inline re-auth rather than a bare 401.

Key invariants: inline auth never changes publish semantics (same tarball, same
manifest, same refusals); non-interactive runs NEVER hang waiting for input —
every would-be prompt becomes a distinct nonzero exit + printed remedy;
`--no-wait` still returns immediately after intake (printing build id, TTY or
not — fix the PRD 07 known-minor while here).

_Boundary:_ packages/cli (+ any tiny cloud status-shape additions left over
from PRD 15). _Depends:_ PRD 15.

## EARS acceptance criteria
- WHEN `hogsend publish` runs on a TTY with no stored session, it SHALL offer
  email-OTP or browser device-flow auth, complete it inline, and proceed with
  the publish without re-invocation; WHEN non-TTY or `--json`, it SHALL exit
  nonzero with the exact `hogsend signup`/`hogsend login` command to run.
- WHEN the target stack is deferred or provisioning, the publish status loop
  SHALL render provisioning phases (distinct from build phases) until running,
  then continue into build/deploy phases, exiting nonzero if provisioning
  fails terminally.
- WHEN a stored session is revoked or expired, publish/whoami SHALL surface the
  fact and (TTY) offer inline re-auth, (non-TTY) print the remedy and exit
  nonzero.
- WHEN `--no-wait` is passed, publish SHALL print the build id and exit 0 right
  after intake regardless of TTY.

## Tasks
1. **Inline auth + provisioning-aware status loop** — auth-offer seam in the
   publish command (reusing the PRD 15 signup/login flows and the existing
   device flow), provisioning-phase rendering in the poll loop, revoked-session
   re-auth path, `--no-wait` build-id fix. Tests: non-TTY never prompts
   (poisoned-stdin fixture), phase-transition rendering, refusal texts.
   _Boundary:_ packages/cli. _Depends:_ —

## Implementation Notes
Shipped in 0c50562e. Inline auth reuses the REAL login flows (device body
extracted as runDeviceLoginCommand, email via runEmailLoginCommand with verb
"login") so an inline session is indistinguishable from `hogsend login`'s.
The non-interactive refusal is one branch in runInlineAuth (`--json` counts
as non-interactive even on a TTY); withReauth wraps BOTH cloud calls
(listing + upload) and retries exactly once. watchBuild carries a separate
provisionTimeoutMs (20min, matching the cloud's precheck bound); the build
clock starts at the running handoff; build-status lines are held back during
provisioning so the narrative never interleaves; stack error throws
provisioning_failed immediately; `stack` optional for pre-PRD-15 clouds.
--no-wait id moved from outro (no-op off TTY) to log. Publish test seams via
module-scoped configurePublish/resetPublish. 365 cli tests; four guards
mutation-tested — one mutation exposed an unfaithful Output stub (intro/outro
recorded when non-interactive) which was fixed in both new suites; the same
stub shape in env-pull-command.test.ts is a known pre-existing minor. Real
E2E smoke: watched deferred→provisioning→running narrative live, revoked a
session mid-flight, piped --no-wait printed the id.
