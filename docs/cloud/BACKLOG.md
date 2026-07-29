# Hogsend Cloud — BACKLOG

Ordered queue. Statuses: `[ ]` not started · `[~]` shipped-to-seam (human ask outstanding)
· `[x]` shipped. Only the orchestrator edits this file.

| # | PRD | Status | Depends | Scope |
|---|---|---|---|---|
| 01 | [cloud-scaffold](prds/01-cloud-scaffold.md) | [x] | — | apps/cloud Next.js app, ds port, cloud DB + migrations, health, worker entry, gates |
| 02 | [tenant-model](prds/02-tenant-model.md) | [x] | 01 | org→env→stack schema, state machine, encrypted provider keys, plan limits, audit |
| 03 | [auth-dashboard](prds/03-auth-dashboard.md) | [x] | 02 | signup/OTP/org-create, dashboard shell, members/roles, essentials (legal, API docs) |
| 04 | [substrate-provisioner](prds/04-substrate-provisioner.md) | [~] | 02, 03 | SubstrateProvider Fake+Railway, tenant DB + Hatchet minting, provision pipeline, ops UI |
| 05 | [onboarding-keys](prds/05-onboarding-keys.md) | [x] | 03, 04 | paste-your-keys flow, live validation, env sync |
| 06 | [billing-metering](prds/06-billing-metering.md) | [~] | 04 | Stripe tiers + trial, usage counters, limit enforcement, Usage page (seam: Stripe test keys + price IDs) |
| 08 | [build-pipeline](prds/08-build-pipeline.md) | [~] | 04 | scaffold Dockerfile, cloud build + preflight gate, GHCR, deployImage (seam: registry credential + CLOUD_IMAGE_REGISTRY) |
| 07 | [cli-login-publish](prds/07-cli-login-publish.md) | [ ] | 03, 08 | hogsend login/whoami/publish/open, device flow, credential store |
| 09 | [environments](prds/09-environments.md) | [ ] | 05, 07, 08 | staging/test envs, TEST_MODE, publish --env, promote |
| 10 | [fleet-health](prds/10-fleet-health.md) | [ ] | 04 | operator console, fleet rollups, abuse suspend |
| 11 | [dedicated-tier](prds/11-dedicated-tier.md) | [ ] | 04, 06 | rung-0 topology, custom tracking domains, EU region |
| 12 | [offboarding](prds/12-offboarding.md) | [ ] | 04 | export, deletion lifecycle, self-host eject |
