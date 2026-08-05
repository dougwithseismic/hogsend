# PRD 15 — CLI-native signup + provision-on-first-publish

## Scope
Close the browser-only front door. Two new cloud endpoints expose the EXISTING
email-OTP auth to the CLI: `POST /api/cli/signup` (email → OTP mail via the
existing Resend sender) and `POST /api/cli/signup/verify` (email + code →
create-or-login user, auto-create org, mint a CLI session token in one round
trip). "Email is correct" IS the auth — the OTP proves inbox ownership, same
trust level as the browser flow. No password, no new auth model.

Provisioning moves to **first publish**: signup/verify mints org + production
environment + stack row in a new `deferred` state but does NOT enqueue
substrate provisioning. The publish intake promotes a `deferred` stack to
`requested` (enqueue) before accepting the build; the build pipeline waits for
the stack to reach running. Gate the behavior on `CLOUD_PROVISION_ON=
signup|first-publish` (default `first-publish`, applied to BOTH the browser
create-org path and the CLI path — one policy, not two). Rationale: a Railway
stack per verified email is real money per signup; deferring keeps drive-by
verifications free and `publish` already polls, so the UX cost is a longer
first publish.

CLI side: `hogsend signup [--email <e>] [--org <name>]` (interactive prompts
when flags absent; OTP read from stdin; `--json` for agents) and
`hogsend login --email <e>` as the headless alias for an EXISTING user (same
endpoints — verify logs in rather than creating). Token lands in
`~/.hogsend/credentials.json` exactly like the device flow.

Key invariants: OTP endpoints rate-limited per email AND per IP (right-anchored
XFF, same CLOUD_TRUSTED_PROXY_HOPS discipline as PRD 07); verify attempts
capped then code burned; an existing verified email is LOGGED IN, never
silently re-signed-up into a new org (org creation only when the user has no
org; `--org` on an existing single-org user is a refusal naming `hogsend open`,
not a second org); the session token appears in exactly one response; email
enumeration not leaked (signup responds identically for new/existing emails).

_Boundary:_ apps/cloud (endpoints, provisioning gate) + packages/cli (signup/
login commands). _Depends:_ PRD 03, 04, 07 (all shipped).

## EARS acceptance criteria
- WHEN `POST /api/cli/signup` receives a syntactically valid email, it SHALL
  send an OTP via the existing email-OTP machinery and respond 200 with an
  opaque pending handle — identically whether the email is new or already
  registered; invalid emails SHALL 400 without sending.
- WHEN `POST /api/cli/signup/verify` receives the correct OTP within its TTL,
  it SHALL create the user if new, create an organization + production
  environment + stack row (state `deferred` under `CLOUD_PROVISION_ON=
  first-publish`) if the user has none, mint a CLI session (same `cli_sessions`
  table, sha256-at-rest, membership re-read per use) and return the plaintext
  token exactly once with org/environment ids. A wrong code SHALL decrement a
  bounded attempt budget and burn the code at zero.
- WHEN a verified user who already has an org verifies again, the endpoint
  SHALL log them into the existing org (fresh CLI session, no new org) and say
  so in the response.
- WHEN the publish intake (`POST /api/publish/:environmentId`) receives a build
  for an environment whose stack is `deferred`, it SHALL atomically promote the
  stack to `requested`, enqueue provisioning, and accept the build; the build
  SHALL NOT deploy until the stack reports running, and build status polling
  SHALL surface distinct `provisioning` phases so the CLI can render them.
- WHEN `CLOUD_PROVISION_ON=signup`, both browser create-org and CLI verify
  SHALL enqueue provisioning immediately (today's behavior preserved).
- WHEN `hogsend signup` runs interactively, it SHALL prompt for email (and org
  name), instruct the user to check their inbox, read the OTP from stdin, and
  persist the returned token to `~/.hogsend/credentials.json` (0600, atomic,
  keyed by host); `--json` SHALL emit machine-readable step results and never
  the token to stdout logs beyond the credentials write.
- WHEN either OTP endpoint is hammered, per-email and per-IP rate limits SHALL
  refuse with 429 and the CLI SHALL render the retry-after.

## Tasks
1. **Cloud: signup/verify endpoints + deferred provisioning** — the two routes
   (reusing Better Auth emailOTP internals or a parallel `cli_otp` table if the
   plugin can't be driven headless — decide in-code, document which), org/env/
   stack minting extracted from `org-provision.ts` into a shared helper with a
   `provision: boolean` knob, `deferred` stack state + promote-on-publish in
   the intake + build-waits-for-running in `pipeline/build.ts`, the
   `CLOUD_PROVISION_ON` flag threaded through browser create-org too. Tests:
   enumeration parity, attempt burn, deferred→requested promotion race (two
   concurrent publishes promote once). _Boundary:_ apps/cloud. _Depends:_ —
2. **CLI: `hogsend signup` + `login --email`** — new command + login flag over
   the endpoints, interactive prompts + stdin OTP + `--json`, credentials
   write, refusal rendering (429 retry-after, attempt-burned, org-exists).
   _Boundary:_ packages/cli. _Depends:_ 1

## Implementation Notes
Shipped in 2 commits (T1 cloud 947431cf; T2 CLI e7d5eb6e). T1: Better Auth
emailOTP "sign-in" type drives the whole flow headless (send mails unknown
addresses, verify creates the user with emailVerified) — no parallel cli_otp
table; enumeration parity is structural (verify precedes user lookup) and
asserted byte-for-byte. Stacks born `deferred` (edge deferred→requested only;
promote via guarded transition in the intake, winner enqueues); build precheck
polls bounded 20min/5s with per-PHASE log lines and instant failure on
undriven statuses; GET /api/builds/:id carries stack:{status} instead of a new
build status (avoids widening the single-flight unique index). deferred added
to alert-sweep UNALERTED_STATUSES (else every idle signup pages) and kept out
of ops-stats in-flight. provisionOrganization takes headers XOR userId with a
row-delete rollback on the headless path. 1006 cloud tests; promotion race +
policy guards mutation-tested. T2: one shared email-login flow behind
`signup` and `login --email` (server reports created rather than caller
choosing); wrong-code retries in place capped at 2 (< server's 3-budget);
storeCloudLogin extracted so both login paths share write-token-first
ordering; raw-stdin read-line (readline would keep the process alive); token
asserted absent from full scrollback incl. failure paths. 351 cli tests +
real E2E smoke against next dev + Postgres (deferred stack verified, no
second org on re-signup, cleanup confirmed). Known minors: "10 minutes" copy
hardcoded despite expiresInSeconds in the response; interactive clack
branches covered by hand, not suite; --label not exposed on signup
(hostname always).
