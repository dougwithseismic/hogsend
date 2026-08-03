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
Shipped in 3 commits (T1 `ArtifactStore` seam; T2 S3 store + boot guard; T3
sandbox build host). 891 cloud tests at close, from 829.

T1 is a pure refactor plus a `get` capability: the free functions became
`LocalDiskArtifactStore`, every containment check carried over verbatim, and
the pipeline now stages the fetched bytes at `${workDir}.artifact.tar.gz` — a
SIBLING of the unpack tree, so a tenant's archive never sits inside the docker
build context it produced.

T2 shares one `parseArtifactKey` between both stores, so a bad key is refused
before any request leaves the process on either backend. The contract suite
runs both implementations unchanged; the S3 fake is deliberately STRICTER than
real S3 (it throws on deleting an absent key, which real S3 answers 204) so
"remove tolerates absence" proves the store's tolerance rather than the
backend's. Boot guard: a partial bucket set throws in EVERY environment, and
production with no bucket refuses to boot — the local store cannot work when
the upload lands on cloud-app and the build runs on cloud-worker.

T3 keeps the seven stages untouched: `runBuildOnHost` selects local (default)
or a per-build Railway Sandbox session, injecting its `ExecFn` into both
command seams. `sandboxExec` takes a single command STRING while `ExecFn` is
argv, so `quoteShellArg` single-quote-wraps every argument (a complete defence,
not a denylist) and refuses NUL; the property is proven against a real bash.
`docker login` is `--password-stdin` and no command string is ever logged.
Always-destroy in a `finally` that never throws.

Live config, read from a real Railway Bucket rather than assumed: `urlStyle`
is **virtual-host**, NOT path-style (the code's first guess was wrong and
would have failed on the first upload), and `region` is `auto`.

Bucket `hogsend-artifacts` created in the hogsend-cloud project, region `ams`
— the us-1 cell actually runs in EU West, so artifacts sit beside the
instances they build for. All five vars set on cloud-app and cloud-worker.

Deferred / seams: sandbox checkpoints for a warm layer cache; Railway
Sandboxes are still beta.

## T4 — BuildKit, not the legacy builder

The first live sandbox build failed at `COPY . .`:

```
NotFound: parent snapshot sha256:e17c3853f8a6... does not exist: not found
```

The sandbox image ships Docker 29 with the containerd image store but WITHOUT
the buildx plugin, so `docker build` fell back to the deprecated legacy
builder. Some sandbox VMs arrive carrying classic-builder cache metadata whose
backing snapshots are gone. The legacy builder trusts that metadata: it
reports `---> Using cache` down the unchanged prefix, then dies at the first
cache MISS — `COPY . .`, the first tenant-content-dependent step — when it
must materialise the missing parent.

The bootstrap now installs buildx (pinned, checksum-verified against the
release digest) and aliases `docker build` to it. BuildKit validates its own
cache store and ignores classic-builder metadata, so a poisoned VM builds
correctly. The pipeline argv and all seven stages are unchanged. Install
failure is fatal and named (exit 71–74: download / checksum / plugin
handshake / alias) — there is deliberately NO fallback to the legacy builder,
because the fallback is the bug.

Honesty on the root cause: the terminal error was **not reproduced on
demand**. A real scaffolded app built cleanly, cold and warm, in fresh
sandboxes. What the evidence establishes is that the failing logs cache-hit on
a `pnpm fetch` step keyed to the tenant's own lockfile — which only a prior
hogsend build could seed — while the pipeline uses a fresh sandbox per
attempt. So that docker state predated the build. A healthy daemon was shown
live to be unable to self-inflict the split: committed snapshots are
lease-protected, and `docker rmi` removes metadata and snapshots together.
The provisioning-side actor is Railway-internal. This fix makes us immune
rather than dependent on their hygiene.

If it recurs, capture `docker images -a` together with
`ctr --address /run/docker/containerd/containerd.sock -n moby snapshots ls`
BEFORE teardown — that pair confirms or kills the recycling theory.

## Status

`CLOUD_BUILD_HOST=sandbox` is live in production. A real scaffolded app now
travels laptop → bucket → cloud-worker → sandbox → unpack → `docker build`
→ tenant image, verified end to end against the live control plane.

The remaining gate is deploy-config drift, working as designed: the published
`create-hogsend` template still carried `pnpm start` / `pnpm worker`, which
EACCES crash-loop in the production image, so preflight refused the image and
nothing was pushed or deployed. The repo template was already correct; it had
never been published. That is what the accompanying `create-hogsend` release
ships.
