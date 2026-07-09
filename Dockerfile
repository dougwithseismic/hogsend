# Hogsend — one runtime image, run three ways via command override:
#   api      (default)  ->  node apps/api/dist/index.js        (HTTP, port 3002)
#   worker               ->  node apps/api/dist/worker.js       (task executor)
#   migrate              ->  tsx packages/db/src/migrate.ts     (one-shot)
#
# Multi-stage on node:22-bookworm-slim (matches .node-version) with corepack
# pnpm@9.0.0 (matches root packageManager). tsup bundles every @hogsend/* package
# (incl. @hogsend/engine) into apps/api/dist via noExternal, so the api/worker
# entrypoints are self-contained for first-party code; their npm runtime deps
# resolve from node_modules. Migrations are NOT bundled: db:migrate runs via tsx
# and resolves `new URL("../drizzle", import.meta.url)` at runtime, so the runner
# also ships packages/db source + its drizzle/ SQL + tsx + drizzle-orm + postgres.
#
# `pnpm deploy` produces self-contained, pruned node_modules per project so the
# runner carries ONLY the api's prod deps + the db package's deps (incl. tsx) —
# never the docs site's Next.js/sharp/shiki surface that a workspace-wide install
# would otherwise materialize into the shared virtual store.

# ---------------------------------------------------------------------------
# 1. base — pinned node + pnpm, shared by every later stage.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# Pin the store inside the image FS so it can be carried between stages with COPY
# (cache mounts can't be COPYed and don't create stage-dependency edges).
ENV PNPM_STORE_DIR="/pnpm/store"
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate \
  && pnpm config set store-dir "$PNPM_STORE_DIR" --global
WORKDIR /app

# ---------------------------------------------------------------------------
# 2. fetch — populate the pnpm store from the lockfile only. This layer is
#    cached on the lockfile hash, so source edits don't re-download deps. The
#    store lands in the image FS (/pnpm/store) so later stages COPY it.
# ---------------------------------------------------------------------------
FROM base AS fetch
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch

# ---------------------------------------------------------------------------
# 3. build — bring the warm store from fetch, install the full workspace offline,
#    tsup-build @hogsend/api (which bundles all @hogsend/* deps into
#    apps/api/dist), then `pnpm deploy` pruned bundles for the runner:
#      /deploy/api — @hogsend/api prod deps only (the api/worker runtime).
#      /deploy/db  — @hogsend/db prod deps only (drizzle-orm + postgres); tsx is
#                    shipped separately as a global tool (see below).
# ---------------------------------------------------------------------------
FROM base AS build
# inject-workspace-packages makes pnpm 9's `deploy --prod --filter` actually prune
# to the target project's own dep graph; without it deploy copies the whole
# workspace virtual store (Next.js/sharp/turbo/biome) into every bundle. It must
# be set before the install so the resulting layout supports injected deploys.
RUN pnpm config set inject-workspace-packages true --global
COPY --from=fetch /pnpm/store /pnpm/store
COPY . .
RUN pnpm install --frozen-lockfile --offline
RUN pnpm --filter @hogsend/api build
# Build the Studio SPA → packages/studio/dist (static, base /studio/). It is NOT
# a runtime dependency of the engine; it ships as a built artifact the runner
# serves at /studio. Built here while the full workspace (incl. vite) is present.
RUN pnpm --filter @hogsend/studio build
# Journey graph manifest: extract every journey's authored control flow from
# source at build time (the runner ships no .ts source), writing
# /app/.hogsend/journeys.graph.json. The admin graph route reads it via
# HOGSEND_GRAPH_MANIFEST so Studio's Flow tab renders the RICH graph in
# production instead of the metadata skeleton.
RUN pnpm --filter @hogsend/cli exec tsx src/bin.ts journeys graph --all \
  --cwd /app --source apps/api/src/journeys
RUN pnpm --filter @hogsend/api deploy --prod /deploy/api \
  && pnpm --filter @hogsend/db deploy --prod /deploy/db
# tsx is a devDep dropped by `deploy --prod`, but db:migrate runs `tsx
# src/migrate.ts`. Install it as a standalone global tool the runner can carry.
RUN pnpm add -g tsx@4.22.3

# ---------------------------------------------------------------------------
# 4. runner — slim production image built purely from the two deploy bundles.
#    No install runs here; the bundles already carry pruned node_modules.
#      /app/apps/api      — api/worker bundle + its prod node_modules.
#      /app/packages/db   — db source + drizzle SQL + db node_modules (incl. tsx).
# ---------------------------------------------------------------------------
FROM base AS runner
ENV NODE_ENV=production

# api/worker: deploy bundle (prod node_modules) + the tsup dist output. `deploy`
# carries package.json + node_modules; dist is copied explicitly to be sure it is
# present regardless of the bundle's file selection.
COPY --from=build /deploy/api/node_modules ./apps/api/node_modules
COPY --from=build /deploy/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist

# db: deploy bundle (prod node_modules — drizzle-orm + postgres) + source +
# drizzle/ SQL, so `tsx src/migrate.ts` resolves `new URL("../drizzle", ...)`.
COPY --from=build /deploy/db/node_modules ./packages/db/node_modules
COPY --from=build /deploy/db/package.json ./packages/db/package.json
COPY --from=build /app/packages/db/src ./packages/db/src
COPY --from=build /app/packages/db/drizzle ./packages/db/drizzle
COPY --from=build /app/packages/db/drizzle.config.ts ./packages/db/drizzle.config.ts

# Studio SPA: the built static dist, served at /studio by the engine's
# best-effort mount. STUDIO_DIST_PATH points the mount straight at it so it does
# not depend on cwd or module resolution.
COPY --from=build /app/packages/studio/dist ./packages/studio/dist
ENV STUDIO_DIST_PATH=/app/packages/studio/dist

# Journey graph manifest (generated in the build stage): the admin graph route
# serves the rich control-flow graph from it. Pinned via env so it does not
# depend on the process cwd.
COPY --from=build /app/.hogsend ./.hogsend
ENV HOGSEND_GRAPH_MANIFEST=/app/.hogsend/journeys.graph.json

# Global tsx (dropped by `deploy --prod`) for the migrate run mode. /pnpm is on
# PATH (set in base), so the `tsx` shim resolves for `tsx packages/db/src/migrate.ts`.
COPY --from=build /pnpm/tsx /pnpm/tsx
COPY --from=build /pnpm/global /pnpm/global

# Drop to the unprivileged user the node image already ships. The app only reads
# node_modules/dist at runtime (no writes), so the root-owned, world-readable
# files need no recursive chown — which would otherwise duplicate the whole tree.
USER node

EXPOSE 3002

# Default run mode is the api. Override the command for worker / migrate:
#   docker run ... <image>                                   # api
#   docker run ... <image> node apps/api/dist/worker.js      # worker
#   docker run ... <image> tsx packages/db/src/migrate.ts    # migrate one-shot
# (migrate runs tsx directly, not via `pnpm run`, to avoid pnpm's deps-status
#  check trying to mutate the read-only node_modules / re-resolve corepack.)
CMD ["node", "apps/api/dist/index.js"]
