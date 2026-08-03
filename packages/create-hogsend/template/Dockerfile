# Hogsend app — one runtime image, run three ways via command override:
#   api      (default)  ->  node dist/index.js       (HTTP, port 3002)
#   worker               ->  node dist/worker.js     (task executor)
#   migrate              ->  tsx scripts/migrate.ts  (one-shot, engine+client)
#
#   docker build -t my-app .
#   docker run --env-file .env -p 3002:3002 my-app                  # api
#   docker run --env-file .env my-app node dist/worker.js           # worker
#   docker run --env-file .env my-app tsx scripts/migrate.ts        # migrate
#
# Migrate runs `tsx` DIRECTLY, never `pnpm db:migrate`: pnpm's deps-status check
# tries to mutate node_modules (and re-resolve corepack) on a read-only,
# root-owned tree running as an unprivileged user — that is an EACCES
# crash-loop, not a migration. Same reason nothing here writes to disk at
# runtime: no log directory, no cache dir, no chown of the app tree.
#
# Multi-stage on node:22-bookworm-slim (matches .node-version) with corepack
# pnpm pinned to this app's `packageManager` field. `pnpm build` (tsup) bundles
# every `@hogsend/*` package into dist/ via `noExternal`, so the api/worker
# entrypoints are self-contained for first-party code; their npm runtime deps
# resolve from node_modules. Migrations are NOT bundled — `scripts/migrate.ts`
# runs under tsx and reads `./migrations` at runtime, so both ship in the runner
# alongside the pruned production node_modules.
#
# LOCKFILE: a freshly scaffolded app has no `pnpm-lock.yaml` until its first
# install. This file handles both cases — with a lockfile the dependency layer
# is cached on its hash and the install is offline + frozen (reproducible);
# without one, dependencies are resolved from the registry at build time and a
# lockfile is generated inside the image. Commit your lockfile (and make sure
# any publish tarball carries it) if you want reproducible, cache-friendly
# builds: a lockfile-less build re-resolves every dependency on every run.

ARG NODE_IMAGE=node:22-bookworm-slim
# Must match this app's package.json `packageManager` field. Override with
# `--build-arg PNPM_VERSION=…` if you re-pin it.
ARG PNPM_VERSION=11.12.0

# ---------------------------------------------------------------------------
# 1. base — pinned node + pnpm, shared by every later stage.
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base
ARG PNPM_VERSION
ENV PNPM_HOME="/pnpm"
# Pin the store inside the image FS so it can be carried between stages with
# COPY (cache mounts can't be COPYed and don't create stage-dependency edges).
ENV PNPM_STORE_DIR="/pnpm/store"
# `/app/node_modules/.bin` is what makes the migrate run mode work: `tsx` is
# resolved from the app's own node_modules, with no package manager involved.
ENV PATH="$PNPM_HOME/bin:$PNPM_HOME:/app/node_modules/.bin:$PATH"
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate \
  && pnpm config set store-dir "$PNPM_STORE_DIR" --global
WORKDIR /app

# ---------------------------------------------------------------------------
# 2. fetch — populate the pnpm store from the lockfile only. This layer is
#    cached on the lockfile hash, so source edits don't re-download deps. The
#    store lands in the image FS (/pnpm/store) so the build stage COPYs it.
#    The `[l]` bracket globs make the lockfile + settings file OPTIONAL (a
#    never-installed scaffold has no lockfile); package.json always matches, so
#    the COPY itself always has a source.
# ---------------------------------------------------------------------------
FROM base AS fetch
COPY package.json pnpm-lock.yam[l] pnpm-workspace.yam[l] ./
# The mkdir is not incidental: with no lockfile there is nothing to fetch, and
# the build stage's `COPY --from=fetch /pnpm/store` fails the whole build on a
# missing path. An empty store is a valid (cold) store.
RUN mkdir -p "$PNPM_STORE_DIR" \
  && if [ -f pnpm-lock.yaml ]; then \
       pnpm fetch; \
     else \
       echo "no pnpm-lock.yaml — skipping fetch; the build stage resolves from the registry"; \
     fi

# ---------------------------------------------------------------------------
# 3. build — bring the warm store from fetch, install, tsup-build to dist/,
#    then re-materialise node_modules from the store with `--prod` so the tree
#    the runner copies contains only the PRODUCTION dependency graph.
#
#    The `rm -rf node_modules` is load-bearing, not tidiness: `pnpm install
#    --prod` run in place only unlinks the top-level symlinks, leaving every
#    devDependency's real directory behind under `node_modules/.pnpm` — biome's
#    ~49 MB platform binary, tsup, rollup, sucrase and friends all ship in the
#    runner. Deleting first makes the install rebuild the tree from the store,
#    which is where the size actually comes off.
#
#    What this guarantees is exactly one thing: devDependencies are dropped. It
#    does NOT mean the runner is free of dev-flavoured packages — `better-auth`
#    declares vitest, typescript, drizzle-kit and react-email as production
#    `optionalDependencies`, so they are legitimately part of the prod graph and
#    stay. Add a pnpm ignore for those optional peers if you want them gone.
#
#    (`tsx` is a production dependency precisely because `scripts/migrate.ts`
#    is a production entry point — it survives the prune.)
# ---------------------------------------------------------------------------
FROM base AS build
COPY --from=fetch /pnpm/store /pnpm/store
COPY . .
RUN if [ -f pnpm-lock.yaml ]; then \
      pnpm install --frozen-lockfile --offline; \
    else \
      pnpm install --no-frozen-lockfile; \
    fi
RUN pnpm build
RUN rm -rf node_modules && pnpm install --prod --frozen-lockfile --offline

# ---------------------------------------------------------------------------
# 4. runner — slim production image: the tsup output, the pruned production
#    node_modules, and the two things migrate mode needs that are NOT bundled
#    (scripts/migrate.ts + the client-track migrations/ SQL).
# ---------------------------------------------------------------------------
FROM base AS runner
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/migrations ./migrations

# Studio SPA: `@hogsend/studio` is a production dependency, so its prebuilt
# dist/ is already in node_modules. Point the engine's best-effort mount
# straight at it so serving /studio does not depend on cwd or on
# `require.resolve` reaching through a bundled entrypoint.
ENV STUDIO_DIST_PATH=/app/node_modules/@hogsend/studio/dist

# Drop to the unprivileged user the node image already ships. The app only
# reads node_modules/dist/migrations at runtime (no writes), so the root-owned,
# world-readable files need no recursive chown — which would otherwise
# duplicate the whole tree into another layer.
USER node

EXPOSE 3002

# Default run mode is the api. Override the command for worker / migrate (see
# the header). Never `pnpm <script>` at runtime.
CMD ["node", "dist/index.js"]
