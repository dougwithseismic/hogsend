import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serveStatic } from "@hono/node-server/serve-static";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../app.js";

/**
 * Where the built Studio SPA lives. The Studio (`@hogsend/studio`) is a separate
 * Vite package that builds to a static `dist/` under base `/studio/`. The engine
 * serves that `dist/` as static files at `/studio/*` with an SPA fallback.
 *
 * The Studio is NOT a runtime dependency of the engine — it ships as a built
 * artifact and is optional. Mounting is best-effort: if no `dist/` is found, the
 * mount is silently skipped so an unbuilt / studio-less deploy never crashes.
 *
 * Resolution order:
 *  1. `STUDIO_DIST_PATH` env var (explicit override; absolute or cwd-relative).
 *  2. `require.resolve("@hogsend/studio/package.json")` → sibling `dist/`
 *     (works when the studio package is installed/linked alongside the engine).
 *  3. Monorepo source layout: walk up from this file to `packages/studio/dist`.
 *  4. cwd-relative `packages/studio/dist` (dogfood app run from repo root).
 */
function resolveStudioDist(): string | null {
  const candidates: string[] = [];

  const envPath = process.env.STUDIO_DIST_PATH;
  if (envPath && envPath.length > 0) {
    candidates.push(resolve(process.cwd(), envPath));
  }

  const require = createRequire(import.meta.url);
  try {
    const pkgJson = require.resolve("@hogsend/studio/package.json");
    candidates.push(join(dirname(pkgJson), "dist"));
  } catch {
    // Not resolvable as a module — fall through to layout-based guesses.
  }

  // Monorepo source layout: this file is packages/engine/src/lib/studio.ts, so
  // the studio dist is ../../../studio/dist relative to here.
  const here = dirname(fileURLToPath(import.meta.url));
  candidates.push(resolve(here, "../../../studio/dist"));

  // cwd fallbacks for a repo-root process (apps/api dogfood, tests).
  candidates.push(resolve(process.cwd(), "packages/studio/dist"));
  candidates.push(resolve(process.cwd(), "../../packages/studio/dist"));

  for (const dir of candidates) {
    if (existsSync(join(dir, "index.html"))) {
      return dir;
    }
  }
  return null;
}

export interface MountStudioResult {
  /** True when the SPA was mounted, false when no built dist was found. */
  mounted: boolean;
  /** Absolute path to the served dist directory, when mounted. */
  distPath?: string;
}

/**
 * Mount the Studio SPA at `/studio/*` as static files, with an SPA fallback to
 * `index.html` for client-side routes.
 *
 * IMPORTANT: this is intentionally OUTSIDE the `/v1/admin` auth guard at the
 * static layer. The SPA itself gates access via `/v1/auth/status` + login; the
 * actual data endpoints under `/v1/admin/*` stay protected by `requireAdmin`.
 *
 * No-op (returns `{ mounted: false }`) when no built `dist/` is found, so an
 * unbuilt studio never crashes the server.
 */
export function mountStudio(app: OpenAPIHono<AppEnv>): MountStudioResult {
  const distPath = resolveStudioDist();
  if (!distPath) {
    return { mounted: false };
  }

  // serveStatic resolves `path` relative to `root` (which is relative to cwd by
  // default). We pass an absolute `root` and strip the `/studio` URL prefix so a
  // request for `/studio/assets/x.js` maps to `<dist>/assets/x.js`.
  const staticHandler = serveStatic({
    root: distPath,
    rewriteRequestPath: (path) => path.replace(/^\/studio/, "") || "/",
  });

  // Redirect the bare `/studio` to `/studio/` so relative/base assets resolve.
  app.get("/studio", (c) => c.redirect("/studio/"));

  // Static assets (js/css/images) under /studio/*.
  app.use("/studio/*", staticHandler);

  // SPA fallback: any /studio/* path that didn't resolve to a file serves
  // index.html so client-side (TanStack Router) routes work on hard refresh.
  const indexHandler = serveStatic({
    root: distPath,
    rewriteRequestPath: () => "/index.html",
  });
  app.get("/studio/*", indexHandler);

  return { mounted: true, distPath };
}
