# PRD 17 — `create-hogsend --cloud`: scaffold → live instance in one command

## Scope
Opt-in cloud handoff at the end of the scaffold. Interactive: after the
existing prompts, one new question ("Deploy to Hogsend Cloud when we're done?
We'll email you a code.") with an email prompt on yes. Headless: `--cloud
[--email <e>] [--org <name>]`; `--cloud` without `--email` in headless mode is
a refusal (flags-required rule already holds). After bootstrap succeeds, the
scaffolder drives the SAME flows PRD 15/16 built — signup/login then publish —
by invoking the scaffolded app's own `hogsend` binary (it's a template
dependency; no dlx, no version skew with the engine the app pins). OTP entry
happens in the scaffolder's TTY; headless runs read it from stdin so an agent
with inbox access can complete unattended.

The outro changes shape when `--cloud` ran: instead of the hosting hint, print
the live URL + `hogsend open` + `hogsend env pull` next steps. When `--cloud`
was NOT chosen, the existing `cloud.ts` hint copy stays exactly as is (the
four-mode outro test keeps passing).

Key invariants: a cloud failure NEVER poisons the scaffold — the app is fully
usable locally regardless; every cloud step failure prints the resume command
(`hogsend signup` / `hogsend publish`) and exits with the scaffold intact;
nothing cloud-related runs unless explicitly opted in; the email is used for
cloud auth only (no marketing capture in the scaffolder).

_Boundary:_ packages/create-hogsend (+ template if the binary wiring needs a
script). _Depends:_ PRD 15, 16.

## EARS acceptance criteria
- WHEN the interactive scaffold ends its prompt phase, it SHALL ask the cloud
  question once; on yes it SHALL collect an email and, after bootstrap, run
  signup/login + publish inline, streaming the provisioning/build narrative.
- WHEN `--cloud --email <e> -y` runs headless, it SHALL complete the same flow
  reading the OTP from stdin, emitting the same step results; `--cloud`
  headless without `--email` SHALL refuse before scaffolding starts.
- WHEN any cloud step fails (OTP timeout, rate limit, provision/build failure),
  the scaffold SHALL remain complete and usable, and the outro SHALL print the
  exact resume commands.
- WHEN `--cloud` is absent, byte-identical outro behavior to today (existing
  cloud-outro tests unmodified and green).
- WHEN the cloud flow succeeds, the outro SHALL print the instance URL,
  `hogsend open`, and `hogsend env pull` instead of the hosting hint.

## Tasks
1. **Cloud opt-in flow in the scaffolder** — prompt + flags, post-bootstrap
   driver invoking the scaffolded `hogsend` binary (signup → publish),
   failure-isolated with resume copy, success/failure outro variants + tests
   (headless refusal, failure-leaves-scaffold-intact, outro variants).
   _Boundary:_ packages/create-hogsend. _Depends:_ —

## Implementation Notes
Shipped in e615860b. Driver (cloud-deploy.ts) spawns the scaffolded app's own
CLI via node_modules/@hogsend/cli/dist/bin.js (never the pnpm .bin shim),
stdio inherited so PRD 15/16's prompts and provisioning narrative stream
through untouched. Runs `signup` not `login --email` (signup accepts --org;
org name always passed, defaulting to the app name, so the child never
prompts a second question). Every failure is a returned verdict; scaffold
completeness asserted against the filesystem, refusals asserted to leave NO
directory. Cloud failure exits nonzero (deliberately unlike bootstrap's 0 —
reasoning in source). Outro has three shapes via hostingLines(); no-cloud
path byte-identical (one source-shape assertion updated to the new call, plus
a new delegation test). vitest fileParallelism off (both suites race tsup
into dist/). 20 scaffold tests + full live E2E: scaffold → signup → deferred
→ provisioning → running (engine 0.62.0) in one run, with the workspace CLI
linked in (published 0.62.0 lacks `signup`). Version skew is a non-issue at
release: the scaffold pins ENGINE_VERSION, so the --cloud release installs
the CLI that carries signup — but run scripts/verify-scaffold.sh
--use-tarballs once post-publish. Process catch worth keeping: a mutation
run's stale dist/ made a smoke lie once — always rebuild before smoking.
