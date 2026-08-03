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

**The one thing standing between here and a usable product is `hogsend publish`.**
The pipeline exists and works on a single machine (PRD 08), but in the deployed
control plane the upload lands on `cloud-app`'s disk while the build runs on
`cloud-worker`, and `cloud-worker` has no Docker daemon. **[PRD 14](prds/14-publish-build-host.md)**
closes both. Everything below it is post-launch.

| # | PRD | Status | Depends | Scope |
|---|---|---|---|---|
| 01 | [cloud-scaffold](prds/01-cloud-scaffold.md) | [x] | — | apps/cloud Next.js app, ds port, cloud DB + migrations, health, worker entry, gates |
| 02 | [tenant-model](prds/02-tenant-model.md) | [x] | 01 | org→env→stack schema, state machine, encrypted provider keys, plan limits, audit |
| 03 | [auth-dashboard](prds/03-auth-dashboard.md) | [x] | 02 | signup/OTP/org-create, dashboard shell, members/roles, essentials (legal, API docs) |
| 04 | [substrate-provisioner](prds/04-substrate-provisioner.md) | [~] | 02, 03 | SubstrateProvider Fake+Railway, tenant DB + Hatchet minting, provision pipeline, ops UI |
| 05 | [onboarding-keys](prds/05-onboarding-keys.md) | [x] | 03, 04 | paste-your-keys flow, live validation, env sync |
| 06 | [billing-metering](prds/06-billing-metering.md) | [~] | 04 | Stripe tiers + trial, usage counters, limit enforcement, Usage page (live keys + prices wired 2026-07-29; seam: webhook secret needs deployed URL) |
| 08 | [build-pipeline](prds/08-build-pipeline.md) | [~] | 04 | scaffold Dockerfile, cloud build + preflight gate, GHCR, deployImage (works single-machine; deployed-path seam moved to PRD 14) |
| 07 | [cli-login-publish](prds/07-cli-login-publish.md) | [x] | 03, 08 | hogsend login/whoami/publish/open, device flow, credential store |
| 13 | [phase0-launch](prds/13-phase0-launch.md) | [x] | 04, 05, 07, 08 | provision re-drive sweep, real mint-credentials, non-running alert, environment page, CLI seam copy, `hogsend env pull` |
| 14 | [publish-build-host](prds/14-publish-build-host.md) | [ ] | 08 | **NEXT — the launch blocker** — ArtifactStore seam + Railway Buckets, production boot guard, Railway-Sandbox build host |
| 09 | [environments](prds/09-environments.md) | [ ] | 05, 07, 08 | staging/test envs, TEST_MODE, publish --env, promote |
| 10 | [fleet-health](prds/10-fleet-health.md) | [ ] | 04 | operator console, fleet rollups, abuse suspend |
| 11 | [dedicated-tier](prds/11-dedicated-tier.md) | [ ] | 04, 06 | rung-0 topology, custom tracking domains, EU region |
| 12 | [offboarding](prds/12-offboarding.md) | [ ] | 04 | export, deletion lifecycle, self-host eject |
