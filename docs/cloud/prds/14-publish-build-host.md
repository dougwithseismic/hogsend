# PRD 14 — Publish build host

## Scope
Close `hogsend publish` in production. PRD 08 built the whole pipeline
(intake → unpack → image-build → preflight → push → deploy) and proved it end to
end **on one machine**. Two things stop it working in the deployed control plane:

1. **The artifact never reaches the builder.** The upload is received by
   `cloud-app` and written to its local disk (`CLOUD_ARTIFACTS_DIR=/tmp/artifacts`);
   the build task is enqueued to Hatchet and executes on `cloud-worker` — a
   separate container with a separate ephemeral filesystem. There is no shared
   volume between them (verified 2026-08-03: the only volume in the Railway
   project is `cloud-postgres-volume`). `unpack` would fail to find the file on
   every real publish. Railway volumes attach to exactly one service, so a shared
   mount is not available even in principle: the fix is object storage.
2. **There is no build host.** `cloud-worker` has no Docker daemon. Railway
   Sandboxes do (proven live: Docker 29.1.2, root, a live `/var/run/docker.sock`,
   `docker build` AND `docker run` both exit 0), which keeps the preflight gate —
   the gate runs the built image, so a host that can only build is not enough.

The same fix serves both: once an artifact is addressable by URL rather than by
path, the worker reads it and the sandbox `curl`s it.

_Boundary:_ `apps/cloud`. _Depends:_ PRD 08.
Seams: a Railway Bucket + its credentials (human ask); Railway Sandbox beta access.

## Locked decisions
- **Object storage, not Postgres blobs.** Build tarballs are files fetched once
  and deleted, not data that is queried. Rows of 64MB bloat every backup, flow
  through the WAL, and make vacuum work harder. Cost is not the deciding factor
  either way (~$0.015/GB-month with free egress — cents at this volume).
- **Railway Buckets, via the S3 API.** Managed S3-compatible storage in the same
  project as the control plane: one vendor, one bill, credentials injected as
  service variables. Priced identically to R2 with free egress and free
  operations. A bucket's region is fixed at creation, which suits the cell model —
  a bucket per cell, so a tenant's source lives in the same jurisdiction as the
  instance running it (us-1 now, an EU cell later).
- **The code is plain S3.** Nothing depends on Railway specifically, so moving to
  R2 or S3 proper is a credential change, not a rewrite.
- **No reliance on lifecycle rules.** Railway Buckets support neither lifecycle
  configuration nor versioning nor server-side encryption. The pipeline already
  deletes each artifact explicitly on terminal build status and on environment
  removal, so retention stays the application's job — as it already was.
- **The store is a seam.** Local disk stays the default and the tested path for
  dev and CI; S3 activates on configuration. Production MUST refuse to boot on the
  local store — that is precisely the misconfiguration this PRD exists to kill.
- **Keys are unchanged.** `<environmentId>/<buildId>.tar.gz` stays the row value,
  with the existing uuid validation intact; only the backing store moves.

## EARS acceptance criteria
- WHEN an artifact is written, read, or deleted, the system SHALL route through an
  `ArtifactStore` interface, and SHALL behave identically against the local-disk
  and S3 implementations for every operation in the contract.
- WHEN S3 credentials are configured, the system SHALL use the S3 store; when they
  are absent it SHALL use the local-disk store; and WHEN `NODE_ENV=production` and
  no S3 store is configured, boot SHALL fail with an explicit message naming the
  missing configuration.
- WHEN a key is presented to any store operation, it SHALL be validated by the
  existing uuid rules and SHALL reject traversal, absolute paths, and malformed
  keys before any I/O — including on the S3 path, where a bad key is an object
  name rather than a filesystem path.
- WHEN a build needs its artifact, it SHALL obtain the bytes through the store
  regardless of which container it runs in, and a build enqueued on `cloud-app`
  and executed on `cloud-worker` SHALL find its artifact.
- WHEN an environment is deleted or a build reaches a terminal status, its
  artifacts SHALL be removed from the active store, and a deletion of an absent
  object SHALL succeed rather than raise.
- WHEN the store cannot serve an artifact, the build SHALL fail with a clear
  status and log, and SHALL NOT deploy anything.

## Tasks
1. **`ArtifactStore` seam + local-disk implementation** — extract the current
   `lib/artifacts.ts` free functions behind an `ArtifactStore` interface
   (`put` / `get` / `remove` / `removeEnvironment`, keys unchanged), with
   `LocalDiskArtifactStore` preserving today's exact behaviour including every
   containment check. Resolve the active store once, injectably, and repoint every
   caller (publish intake, `BuildService.transition`, environment removal, the
   build task) at it. Behaviour-preserving: no call site changes meaning.
   _Boundary:_ apps/cloud. _Depends:_ —
2. **S3 implementation + production boot guard** — `S3ArtifactStore` over the
   S3 API (`pnpm add @aws-sdk/client-s3@latest`), selected when the bucket env vars
   are present. Contract-test both implementations against one shared suite so they
   cannot drift. Production refuses the local store at boot. Credentials are the
   seam: until they land, S3 is exercised by the contract suite against a mocked
   client, and the deployed default stays local-disk-plus-refusal so the
   misconfiguration is loud rather than silent.
   _Boundary:_ apps/cloud. _Depends:_ 1
3. **Sandbox-backed `ExecFn` + build lifecycle** — a Railway-Sandbox `ExecFn`
   (`sandboxCreate` → `sandboxExec` per command → `sandboxDestroy`, always
   destroying, including on failure), selected by configuration alongside the
   existing local-exec path. The artifact enters the sandbox by download rather
   than by mount. `docker login` for the GHCR push. The seven pipeline stages are
   unchanged — `ExecFn` is already the only seam they cross.
   _Boundary:_ apps/cloud. _Depends:_ 1, 2

## Implementation Notes
