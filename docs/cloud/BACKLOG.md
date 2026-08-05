# Hogsend Cloud — BACKLOG

Ordered queue. Statuses: `[ ]` not started · `[~]` shipped-to-seam (human ask outstanding)
· `[x]` shipped. Only the orchestrator edits this file.

**Start here: [GUIDE.md](GUIDE.md)** — the definitive plan of record for getting
Cloud going properly (identity and one-click sign-in, reliability, onboarding,
money, ops, and the phase order). [GO-LIVE.md](GO-LIVE.md) is the short launch
checklist; [RUNBOOK.md](RUNBOOK.md) is how to operate what exists.

2026-08-03: Phase 0 SHIPPED (#640, #641). A customer can sign up, get a
provisioned instance, and receive working admin credentials and an API key —
verified live end to end against a real tenant. `cloud.hogsend.com` is up.

2026-08-03: `hogsend publish` runs end to end in the deployed control plane.
A real scaffolded app travels laptop → Railway Bucket → `cloud-worker` →
per-build sandbox → `docker build` → tenant image ([PRD 14](prds/14-publish-build-host.md)).
The artifact no longer depends on a shared disk, and the build no longer
depends on a daemon `cloud-worker` does not have.

2026-08-04: **launch scope is closed.** `create-hogsend` 0.62.0 ships the
corrected Railway run commands, and a freshly scaffolded app published end to
end — build, preflight, GHCR push, deploy — onto a stack that answers
`/v1/health` healthy with database, redis, and worker all up.
`hogsend-default:0.62.0` is built and `CLOUD_DEFAULT_ENGINE_VERSION` points at
it, so new stacks provision on the current engine line.

2026-08-05: backlog re-cut for the **seamless-cloud wave** — CLI-native signup,
provision-on-first-publish, self-healing publish, scaffold `--cloud`, MCP cloud
tools, docs (PRDs 15–19). The old post-launch queue (09–12) is cleared to the
archive below; re-add rows deliberately if/when wanted.

PRDs 01–08, 13 and 14 are done. Active queue is 15–19, in order.
Known non-blocking deferrals are named in each row rather than left implicit.

| # | PRD | Status | Depends | Scope |
|---|---|---|---|---|
| 01 | [cloud-scaffold](prds/01-cloud-scaffold.md) | [x] | — | apps/cloud Next.js app, ds port, cloud DB + migrations, health, worker entry, gates |
| 02 | [tenant-model](prds/02-tenant-model.md) | [x] | 01 | org→env→stack schema, state machine, encrypted provider keys, plan limits, audit |
| 03 | [auth-dashboard](prds/03-auth-dashboard.md) | [x] | 02 | signup/OTP/org-create, dashboard shell, members/roles, essentials (legal, API docs) |
| 04 | [substrate-provisioner](prds/04-substrate-provisioner.md) | [x] | 02, 03 | SubstrateProvider Fake+Railway, tenant DB + Hatchet minting, provision pipeline, ops UI — live: real stacks provisioned on Railway, `mint-credentials` no longer a stub |
| 05 | [onboarding-keys](prds/05-onboarding-keys.md) | [x] | 03, 04 | paste-your-keys flow, live validation, env sync |
| 06 | [billing-metering](prds/06-billing-metering.md) | [x] | 04 | Stripe tiers + trial, usage counters, limit enforcement, Usage page — webhook live at `cloud.hogsend.com` and verified fail-closed in prod. Deferred (not launch-blocking): dedicated `<db>_meter` role, `DATABASE_POOL_MAX` to tenant stacks |
| 08 | [build-pipeline](prds/08-build-pipeline.md) | [x] | 04 | scaffold Dockerfile, cloud build + preflight gate, GHCR, deployImage — GHCR push proven live; deployed path closed by PRD 14. Deferred (not launch-blocking): multi-arch images, `waitForDeploy` on the substrate seam |
| 07 | [cli-login-publish](prds/07-cli-login-publish.md) | [x] | 03, 08 | hogsend login/whoami/publish/open, device flow, credential store |
| 13 | [phase0-launch](prds/13-phase0-launch.md) | [x] | 04, 05, 07, 08 | provision re-drive sweep, real mint-credentials, non-running alert, environment page, CLI seam copy, `hogsend env pull` |
| 14 | [publish-build-host](prds/14-publish-build-host.md) | [x] | 08 | ArtifactStore seam + Railway Buckets, production boot guard, Railway-Sandbox build host on BuildKit — live in prod, verified end to end |
| 15 | [cli-signup-provision](prds/15-cli-signup-provision.md) | [x] | 03, 04, 07 | `/api/cli/signup(+verify)` email-OTP auth, org auto-create, `deferred` stacks + provision-on-first-publish (`CLOUD_PROVISION_ON`), `hogsend signup` / `login --email` |
| 16 | [publish-self-healing](prds/16-publish-self-healing.md) | [x] | 15 | inline auth in `publish`, provisioning-phase status narrative, revoked-session re-auth, `--no-wait` build-id fix |
| 17 | [scaffold-cloud-flag](prds/17-scaffold-cloud-flag.md) | [x] | 15, 16 | `create-hogsend --cloud [--email]`: scaffold → signup → publish in one command, failure-isolated, outro variants |
| 18 | [mcp-cloud-tools](prds/18-mcp-cloud-tools.md) | [ ] | 15, 16 | shared publish/auth libs, `cloud_signup/verify/whoami/publish/build_status` in `@hogsend/mcp` (stdio only) |
| 19 | [cloud-docs](prds/19-cloud-docs.md) | [ ] | 15–18 | docs site: cloud quickstart, CLI cloud reference, Agents & MCP page, outro copy sync |

### Archived (cleared 2026-08-05 — re-add deliberately if wanted)

| # | PRD | Depends | Scope |
|---|---|---|---|
| 09 | [environments](prds/09-environments.md) | 05, 07, 08 | staging/test envs, TEST_MODE, publish --env, promote |
| 10 | [fleet-health](prds/10-fleet-health.md) | 04 | operator console, fleet rollups, abuse suspend |
| 11 | [dedicated-tier](prds/11-dedicated-tier.md) | 04, 06 | rung-0 topology, custom tracking domains, EU region |
| 12 | [offboarding](prds/12-offboarding.md) | 04 | export, deletion lifecycle, self-host eject |
