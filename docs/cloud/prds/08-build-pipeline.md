# PRD 08 — Cloud build pipeline (scoped; flesh out when popped)

## Scope
Turn an uploaded publish tarball into a deployed image. **This PRD owns the publish
intake**: the authenticated upload endpoint (tarball + manifest → stored artifact + build
record) — PRD 07's CLI is a client of it; until PRD 07 lands, intake is exercised by
tests and a curl fixture. This PRD also builds + publishes the **default scaffold image**
(`hogsend-default:<engine-version>`) that PRD 04's provision deploys initially. (1) Generic scaffold `Dockerfile`
added to `packages/create-hogsend/template/` (flat single-package repo: pnpm fetch →
build → pruned prod runner; one image run three ways: migrate/api/worker — mirror the
monorepo Dockerfile patterns incl. tsx-not-pnpm migrate law and STUDIO_DIST_PATH). (2)
Build task in cloud-worker: unpack tarball → docker build with the generic Dockerfile →
run the generalized preflight gate (parameterize `scripts/preflight-deploy.sh` into a
reusable script that boots all run modes against synthetic env and asserts startup
markers) → push to GHCR → `SubstrateProvider.deployImage` (worker first, then api;
migrate runs as pre-deploy) → stack `publishing → running`. Build records table (status,
log tail, image digest, engine version). Dashboard build history + log viewer.

Key invariants: preflight failure = no deploy, clear log surfaced to CLI; engine version
recorded on the stack at success; builds are per-environment; concurrent publish to the
same env queues (never two builds racing one stack).

_Boundary:_ `apps/cloud` + `packages/create-hogsend` (Dockerfile only). _Depends:_ PRD 04.
Seams: GHCR credentials; docker daemon on the build host (local dev: user's Docker).

## Implementation Notes
