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

## EARS acceptance criteria
- WHEN `hogsend login` runs, it SHALL mint a device code against the cloud host, print
  the verification URL + user code, open the browser, and poll until approved or
  expired; an approved session SHALL be stored at `~/.hogsend/credentials.json` (0600,
  keyed by cloud host) and never echoed.
- WHEN the approve page is opened by a signed-in dashboard user, it SHALL show the user
  code + requesting host and require an explicit approve click; approval SHALL bind the
  session to that user and their active organization. Codes SHALL be short-lived
  (≤15 min), single-use, and brute-force-resistant (rate-limited, high-entropy).
- WHEN a CLI session exists, `hogsend whoami` SHALL print user + org + cloud host;
  `hogsend logout` SHALL revoke server-side AND delete the local entry; the dashboard
  (Settings → CLI sessions) SHALL list live sessions with last-used and allow revocation;
  a revoked session SHALL fail closed on next use.
- WHEN `hogsend publish [--env <name>]` runs in a scaffold repo, it SHALL build a
  gitignore-respecting tarball that NEVER contains `.env*`, `node_modules`, `dist`, or
  `.git` (test asserts on a poisoned fixture), attach a manifest (app name, engine
  version from the lockfile, node version), upload it authenticated as the CLI session
  (org-membership-checked server-side) or an `hspub_` token, and stream build status to
  the terminal until terminal state — exiting nonzero on a failed build.
- WHEN the manifest engine version disagrees with the target stack's recorded engine
  version, the intake SHALL refuse with a distinct error unless `--allow-upgrade` set an
  explicit manifest flag; the CLI SHALL surface the refusal with the exact flag to pass.
- WHEN `hogsend open` runs, it SHALL open the dashboard deep link for the current org
  (env-scoped when `--env` is given).

## Tasks
1. **Cloud: device-flow + CLI sessions + publish auth** — `cli_sessions` table (hashed
   token `hscli_…`, userId, organizationId, label, lastUsedAt, revokedAt) + device-code
   flow endpoints under `/api/cli/device` (mint: user code + device code + poll secret;
   poll: pending|approved{token}|expired; rate-limited) + dashboard approve page
   (`/cli/approve?code=…`, signed-in, explicit click) + Settings → CLI sessions list +
   revoke + audit rows. Extend the publish intake to ALSO accept `Bearer hscli_…`
   resolved to org membership (owner/admin/developer) on the environment's org; add
   engine-version mismatch refusal (manifest vs stack, `allowUpgrade` manifest flag
   bypass) + `GET /api/builds/:id` status endpoint under the same dual auth.
   _Boundary:_ apps/cloud. _Depends:_ —
2. **CLI: login/whoami/logout/open** — `packages/cli` commands over the device flow;
   credentials store `~/.hogsend/credentials.json` (0600, per-host map, atomic write);
   config precedence extended (existing operate-an-instance commands unchanged);
   `hogsend open` deep link. _Boundary:_ packages/cli. _Depends:_ 1
3. **CLI: publish** — `hogsend publish [--env <name>] [--allow-upgrade]`: scaffold-root
   detection, tarball via gitignore-respecting walk (hard excludes asserted by test),
   manifest assembly (engine version from lockfile), multipart upload, build status
   polling loop with terminal exit codes, friendly rendering of every intake refusal
   (401/403/409/413/429/version-mismatch). _Boundary:_ packages/cli. _Depends:_ 1

