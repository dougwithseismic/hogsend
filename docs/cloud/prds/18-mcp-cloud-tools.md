# PRD 18 — MCP cloud tools in `@hogsend/mcp`

## Scope
Expose the CLI↔cloud seam as MCP tools so an agent can drive scaffold → signup
→ publish → status without shelling out. New tools in `@hogsend/mcp` (stdio
server; the hosted `/v1/mcp` variant does NOT get these — cloud tools act on
the operator's machine/credentials and have no business on a tenant instance):

- `cloud_signup` — start email OTP (email, optional org name) → pending handle
- `cloud_verify` — complete OTP → session stored in `~/.hogsend/credentials.json`
  (same store the CLI reads; tool NEVER returns the token in its result)
- `cloud_whoami` — session/org/environment summary
- `cloud_publish` — publish the scaffold at a given cwd (delegates to the same
  publish-flow library the CLI uses — `lib/publish-flow.ts` extracted/shared,
  not reimplemented), returns build id immediately
- `cloud_build_status` — poll one build; returns the phase narrative
  (provisioning + build phases from PRD 15/16) as structured JSON

Key invariants: tools share the CLI's config funnel (`HOGSEND_CLOUD_URL`,
credentials file) so CLI and MCP sessions are interchangeable; the session
token never crosses the MCP wire in either direction; `cloud_publish` applies
the identical tarball hard-excludes (the poisoned-fixture test runs against the
shared library, covering both callers); every refusal the CLI renders maps to a
structured MCP error, not a string dump.

_Boundary:_ packages/mcp (+ small extractions in packages/cli to share the
publish/auth libraries). _Depends:_ PRD 15, 16.

## EARS acceptance criteria
- WHEN `cloud_signup` then `cloud_verify` complete with a correct OTP, the
  credentials file SHALL contain a working session usable by BOTH subsequent
  MCP tools and the `hogsend` CLI, and no tool result SHALL contain the token.
- WHEN `cloud_publish` runs in a scaffold with a valid session, it SHALL upload
  via the shared publish-flow library and return the build id; with no session
  it SHALL return a structured needs-auth error naming `cloud_signup`.
- WHEN `cloud_build_status` polls a build on a deferred stack, it SHALL report
  provisioning phases then build phases as structured states until terminal.
- WHEN the tools are listed on the HOSTED `/v1/mcp` server, the cloud_* tools
  SHALL be absent.
- WHEN the poisoned-fixture tarball test runs, it SHALL exercise the shared
  library both callers use.

## Tasks
1. **Extract shared cloud libs** — publish-flow, cloud-session/http, signup
   flow from `packages/cli` into an importable surface (in-package export or a
   tiny internal package — decide in-code) consumed by both CLI and MCP; move
   the poisoned-fixture test to the shared lib. _Boundary:_ packages/cli.
   _Depends:_ —
2. **MCP tools** — the five tools over the shared libs, stdio-only
   registration, structured errors, token-never-on-wire tests, hosted-variant
   absence test. _Boundary:_ packages/mcp. _Depends:_ 1

## Implementation Notes
Shipped in b8974235. T1: `@hogsend/cli/cloud` exports entry (no new package)
— publish flow, tarball (hard excludes), manifest/scaffold detection, cloud
http/session/credentials/config, refusals, email-login; every module behind
the barrel is engine/db-free by written contract; poisoned-fixture test runs
through the shared surface. T2: five tools in packages/mcp; stdio-only is
STRUCTURAL (registerCloudTools imported by bin.ts only; routes.ts asserted
by test to not name it); @hogsend/cli is a devDependency + noExternal so the
stdio bin gains no runtime deps (84KB). HOGSEND_ADMIN_KEY now optional on
the stdio bin — without it instance tools are absent, cloud tools present
(signup precedes any instance); createHogsendMcpServer client? widened,
hosted callers unaffected. Errors are structured, total over the library's
error types, and name TOOLS not commands (needs_auth → cloud_signup).
cloud_publish returns the buildId immediately; cloud_build_status is one
poll. THE SMOKE-FOUND BUG: reusing runEmailLogin for verify re-SENT a code,
rotating the OTP server-side — 100% real-world failure that every scripted
test accepted; fixed by extracting verifyEmailCode (verify leg alone, one
implementation, both callers) + a regression test pinning the exact call
sequence. Full MCP-client smoke against the live cloud: five tools listed,
signup→verify→whoami→publish→status all real, CLI/MCP session
interchangeability proven via shared HOME, token absent from all serialized
results. 80 mcp + 365 cli tests. Known minors: cloud_whoami makes two calls;
no cloud_logout (deliberate — revocation stays a human action).
