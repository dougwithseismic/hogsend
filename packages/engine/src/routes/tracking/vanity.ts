import { links, trackedLinks } from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, asc, eq } from "drizzle-orm";
import type { AppEnv } from "../../app.js";
import { canonicalTrackedRowFilter, normalizeSlug } from "../../lib/links.js";
import { clickSelection, handleTrackedClick } from "./click-pipeline.js";

// The vanity short path — `/l/:slug` layered over `/v1/t/c/:id`. Mounted at
// the APP ROOT (not under /v1/t) so the operator-facing URL stays short; the
// `/l` prefix collides with nothing (`/v1`, `/studio`, `/docs`, `/api/auth`,
// `/connectors`, webhooks).
const vanityRoute = createRoute({
  method: "get",
  path: "/l/:slug",
  tags: ["Tracking"],
  summary: "Vanity link redirect",
  request: {
    params: z.object({
      slug: z.string(),
    }),
  },
  responses: {
    302: { description: "Redirect to original URL" },
  },
});

export const vanityRouter = new OpenAPIHono<AppEnv>().openapi(
  vanityRoute,
  async (c) => {
    const { slug } = c.req.valid("param");
    const { db, env } = c.get("container");

    // Tolerate cased/typed-by-hand input (`/l/Black-Friday`): slugs are stored
    // normalized, so normalize the inbound too. A malformed slug can't match
    // anything — treat it like an unknown link (redirect home), mirroring the
    // UUID route's missing-row behavior.
    let normalized: string;
    try {
      normalized = normalizeSlug(slug);
    } catch {
      return c.redirect(env.API_PUBLIC_URL, 302);
    }

    // Resolve the link's CANONICAL redirect row: a managed link has one
    // tracked row minted alongside it, plus (later) a per-link QR scan row
    // (`source: "qr"`) — the vanity path must never attribute to the QR row.
    // Archived links keep resolving (same as the UUID route, which never
    // checks archived_at) — a printed/shared slug should not 404 on archive.
    const rows = await db
      .select(clickSelection)
      .from(links)
      .innerJoin(trackedLinks, eq(trackedLinks.linkId, links.id))
      .where(and(eq(links.slug, normalized), canonicalTrackedRowFilter()))
      .orderBy(asc(trackedLinks.createdAt))
      .limit(1);

    const link = rows[0];
    if (!link) {
      return c.redirect(env.API_PUBLIC_URL, 302);
    }

    return handleTrackedClick(c, link);
  },
);
