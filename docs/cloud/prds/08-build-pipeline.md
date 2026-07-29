# PRD 08 — Cloud build pipeline

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

## EARS acceptance criteria
- WHEN a scaffolded app is docker-built with the template Dockerfile, the image SHALL run
  three ways by command override (api default / worker / migrate), as non-root, with
  migrate via tsx (never pnpm at runtime) — mirroring the monorepo Dockerfile laws.
- WHEN the generalized preflight runs against any Hogsend image, it SHALL boot every run
  mode on synthetic env with unreachable infra, assert the startup markers, fail on the
  structural-failure markers, and exit nonzero on any mode failing — with the log retained.
- WHEN a publish tarball is uploaded with a valid publish token, the system SHALL store
  the artifact + a build record (queued) and reject invalid/oversize/foreign-env uploads
  storing NOTHING; a second publish to a busy environment SHALL queue, never race.
- WHEN a build runs, it SHALL unpack → docker build → preflight → push → deployImage
  (worker first, api second, migrate as preDeployCommand) → stack publishing→running,
  recording status transitions, log tail, image digest and engine version; preflight
  failure SHALL deploy nothing and surface the log.
- WHEN no tenant code has been published, provision SHALL deploy the default scaffold
  image `hogsend-default:<engine-version>` built by this same pipeline from a
  freshly-generated scaffold.
- WHEN the dashboard build history is opened, it SHALL show per-environment builds with
  status, engine version and a log viewer (last N KB), never secrets.

## Tasks
1. **Scaffold Dockerfile + generalized preflight** — `packages/create-hogsend/template/`
   gains a flat single-package Dockerfile (pnpm fetch → offline install → tsup build →
   pruned prod runner; one image / three run modes; non-root; tsx migrate law) and a
   parameterized `scripts/preflight.sh` (image tag + modes + markers as inputs, ported
   from `scripts/preflight-deploy.sh`); template README notes. Verified by actually
   scaffolding + building + preflighting locally. _Boundary:_ packages/create-hogsend.
   _Depends:_ —
2. **Publish intake + build records** — `builds` table (env-scoped, status machine
   queued|building|preflight|pushing|deploying|succeeded|failed, logTail, imageDigest,
   engineVersion, artifactPath) + hashed per-environment `publish_tokens` (minted on env
   create, shown once, rotatable) + `POST /api/publish/:environmentId` (bearer token,
   multipart tarball ≤ size cap, manifest json) storing to `CLOUD_ARTIFACTS_DIR`;
   single-flight queue per environment; dashboard build history + log viewer.
   _Boundary:_ apps/cloud. _Depends:_ —
3. **Build task + registry seam + default image** — `ImageStore` seam (FakeImageStore;
   GHCR impl: docker build/tag/push via injectable exec) + cloud-worker build task
   walking the record through the machine (unpack → build with the TEMPLATE Dockerfile
   if the tarball carries none → preflight → push → `deployImage` worker-then-api with
   migrate preDeploy → stack publishing→running, engineVersion recorded) + a
   `build-default-image` script/task that scaffolds create-hogsend fresh and runs the
   same pipeline to produce `hogsend-default:<engine-version>` for PRD 04's initial
   deploy. _Boundary:_ apps/cloud (+ scripts). _Depends:_ 1, 2.

## Implementation Notes
Shipped in 3 commits (T1 scaffold Dockerfile + parameterized preflight; T2 publish intake;
T3 build pipeline). 663 cloud tests at close. T1 verified by real scaffold→build→preflight
plus mutation tests; Railway TOMLs pin the DOCKERFILE builder + direct node/tsx commands
(pnpm at runtime crash-loops the non-root image). T2: tokens sha256-at-rest with
constant-time accept, minted in the env-create transaction; single-flight = one RUNNING
build per env with a bounded queue (depth 3, 429 past it) after review caught the 409
refusal contradicting EARS 3 (and a test named for the opposite of what it asserted);
artifacts GC'd on terminal transition + env removal. T3: ImageStore seam (Fake + Docker
via injectable exec, `--platform linux/amd64`, registry-less = honest local-only mode),
hardened in-process ustar reader (traversal/link/device refusal, caps), build task walks
the guarded machine, sweep reaps stale builds AND parks a mid-deploy stack
(`publishing → error`) so nothing wedges. Review caught a BLOCKING tenant-RCE: the
archive's own `scripts/preflight.sh` ran on the build host with full control-plane env —
now the template's script always overwrites it and the gate runs under an env allowlist
with a 20-min process-group-killing timeout. Live proof: `build:default-image` produced
`hogsend-default:0.57.0`, preflight PASSED all three modes. Deferred: `waitForDeploy` on
the substrate seam (deploys are trigger-only; health-poll observes), multi-arch images,
GHCR push (seam: registry credential + `CLOUD_IMAGE_REGISTRY`).
