import { linkClicks, links, trackedLinks } from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, count, desc, eq, inArray, isNull, sql, sum } from "drizzle-orm";
import type { AppEnv } from "../../app.js";
import {
  assertHttpUrl,
  canonicalTrackedRowFilter,
  isSlugUniqueViolation,
  mintLink,
  normalizeSlug,
  SlugTakenError,
  vanityUrlFor,
} from "../../lib/links.js";
import { errorSchema } from "../../lib/schemas.js";

// ---------------------------------------------------------------------------
// Admin CRUD for managed (operator-owned) tracked links — the surface behind
// the Studio "Links" view. A `links` row is the durable, named identity of a
// tracked link; the click counter + per-hit `link_clicks` live in
// `tracked_links` (which back-references via `link_id`). Email's per-send
// rewritten links are a SEPARATE consumer of the same click spine (they keep
// `tracked_links.link_id` NULL) and are NOT listed here — this view is the
// managed/standalone surface only.
//
// The click count is computed ON READ by summing `tracked_links.click_count`
// for the link's `tracked_links` rows — there is deliberately NO denormalized
// counter on `links`, so a click never has to write back to this table.
//
// One FLAT `Link` shape is returned everywhere: `url` is the short redirect URL
// and `clickCount` is the computed count, both baked onto the row. `GET /:id`
// adds a `clicks` array. Archive returns the (now-archived) flat link.
// ---------------------------------------------------------------------------

// Resolves the minting actor across the two admin auth paths (mirrors the audit
// middleware): an API key carries a `name`; a Better-Auth session carries a
// `user` whose email we record. Stored verbatim on `links.created_by`.
function resolveActor(c: {
  get: (k: "apiKey" | "user") => unknown;
}): string | null {
  const apiKey = c.get("apiKey") as { name?: string } | undefined;
  if (apiKey?.name) return apiKey.name;
  const user = c.get("user") as { email?: string } | null | undefined;
  return user?.email ?? null;
}

// ---------------------------------------------------------------------------
// Shared response shapes
// ---------------------------------------------------------------------------

const linkSchema = z.object({
  id: z.string(),
  // The link's redirect tracked-row id (one per managed link). Absent only if a
  // link somehow has no tracked row — kept nullable to stay total.
  trackedLinkId: z.string().nullable(),
  originalUrl: z.string(),
  type: z.enum(["personal", "public"]),
  // Vanity slug (normalized lowercase, unique per instance) + its short URL
  // (`${API_PUBLIC_URL}/l/:slug`). Both null when no slug is set.
  slug: z.string().nullable(),
  vanityUrl: z.string().nullable(),
  label: z.string().nullable(),
  campaign: z.string().nullable(),
  source: z.string(),
  distinctId: z.string().nullable(),
  createdBy: z.string().nullable(),
  // Computed on read (summed across the link's tracked_links rows). The total
  // across ALL entry paths — vanity, UUID, and QR scans.
  clickCount: z.number(),
  // The QR-only subtotal (clicks recorded on the link's `source: "qr"` row).
  scanCount: z.number(),
  // The short redirect URL: `${API_PUBLIC_URL}/v1/t/c/:trackedLinkId`.
  url: z.string(),
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const clickSchema = z.object({
  id: z.string(),
  trackedLinkId: z.string(),
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  clickedAt: z.string(),
});

const linkDetailSchema = linkSchema.extend({
  clicks: z.array(clickSchema),
});

type LinkRow = typeof links.$inferSelect;
type ClickAgg = {
  clicks: number;
  scans: number;
  trackedLinkId: string | null;
};

// The short redirect URL for a link's tracked row, or a bare prefix if the link
// has no tracked row (should not happen for a minted link, but keep it total).
function shortUrlFor(baseUrl: string, trackedLinkId: string | null): string {
  return `${baseUrl}/v1/t/c/${trackedLinkId ?? ""}`;
}

function serializeLink(
  row: LinkRow,
  agg: ClickAgg | undefined,
  baseUrl: string,
): z.infer<typeof linkSchema> {
  const trackedLinkId = agg?.trackedLinkId ?? null;
  return {
    id: row.id,
    trackedLinkId,
    originalUrl: row.originalUrl,
    // The column is a free text; mintLink only ever writes these two values.
    type: row.type === "personal" ? "personal" : "public",
    slug: row.slug,
    vanityUrl: row.slug ? vanityUrlFor(baseUrl, row.slug) : null,
    label: row.label,
    campaign: row.campaign,
    source: row.source,
    distinctId: row.distinctId,
    createdBy: row.createdBy,
    clickCount: agg?.clicks ?? 0,
    scanCount: agg?.scans ?? 0,
    url: shortUrlFor(baseUrl, trackedLinkId),
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const createLinkRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Admin — Links"],
  summary: "Mint a managed tracked link",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            url: z.string().url(),
            type: z.enum(["personal", "public"]).default("public"),
            // Optional vanity slug (`/l/:slug`). Normalized lowercase; 409 if
            // already taken.
            slug: z.string().optional(),
            label: z.string().optional(),
            campaign: z.string().optional(),
            // Honoured ONLY for personal links (the share-safe invariant in
            // mintLink drops it for public). A canonical contact key the click
            // should stitch the visitor's anon session into.
            distinctId: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: linkSchema } },
      description: "Minted link",
    },
    400: {
      content: { "application/json": { schema: errorSchema } },
      description: "Invalid destination URL or slug",
    },
    409: {
      content: { "application/json": { schema: errorSchema } },
      description: "Slug already taken",
    },
  },
});

const listLinksRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin — Links"],
  summary: "List managed links (newest first)",
  request: {
    query: z.object({
      limit: z.coerce.number().min(1).max(200).default(50),
      offset: z.coerce.number().min(0).default(0),
      type: z.enum(["personal", "public"]).optional(),
      includeArchived: z.coerce.boolean().default(false),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            links: z.array(linkSchema),
            total: z.number(),
            limit: z.number(),
            offset: z.number(),
          }),
        },
      },
      description: "Managed link list",
    },
  },
});

const getLinkRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Admin — Links"],
  summary: "Get a managed link with recent clicks",
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: {
      content: { "application/json": { schema: linkDetailSchema } },
      description: "Link detail",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Link not found",
    },
  },
});

const updateLinkRoute = createRoute({
  method: "patch",
  path: "/{id}",
  tags: ["Admin — Links"],
  summary: "Update a managed link (destination URL + label + campaign)",
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            // NOT NULL on both tables — omit = no change, provide = re-target
            // both links.originalUrl and the linked tracked_links row.
            originalUrl: z.string().url().optional(),
            // omit = no change; string = set/replace (409 if taken); null =
            // clear the slug (frees it for reuse).
            slug: z.string().nullable().optional(),
            label: z.string().nullable().optional(),
            campaign: z.string().nullable().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: linkSchema } },
      description: "Updated link",
    },
    400: {
      content: { "application/json": { schema: errorSchema } },
      description: "Invalid destination URL or slug",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Link not found",
    },
    409: {
      content: { "application/json": { schema: errorSchema } },
      description: "Slug already taken",
    },
  },
});

const archiveLinkRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Admin — Links"],
  summary: "Archive a managed link (soft-delete)",
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: {
      content: { "application/json": { schema: linkSchema } },
      description: "Archived link",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Link not found",
    },
  },
});

type Db = AppEnv["Variables"]["container"]["db"];

// Aggregates each link's tracked_links rows in ONE grouped query: the summed
// click_count (computed on read — no denormalized counter on `links`) and the
// link's redirect id — the CANONICAL tracked row (minted alongside the link),
// never the per-link QR scan row, via the shared canonical-row predicate.
// Returns a map keyed by link id; links with no tracked rows are simply absent
// (callers default to 0 / a bare prefix).
async function aggregateFor(
  db: Db,
  linkIds: string[],
): Promise<Map<string, ClickAgg>> {
  const map = new Map<string, ClickAgg>();
  if (linkIds.length === 0) return map;
  const rows = await db
    .select({
      linkId: trackedLinks.linkId,
      clicks: sql<number>`coalesce(${sum(trackedLinks.clickCount)}, 0)`.mapWith(
        Number,
      ),
      // QR-only subtotal — the complement of the canonical-row predicate.
      scans:
        sql<number>`coalesce(${sum(trackedLinks.clickCount)} filter (where not (${canonicalTrackedRowFilter()})), 0)`.mapWith(
          Number,
        ),
      trackedLinkId: sql<string>`min(${trackedLinks.id}::text) filter (where ${canonicalTrackedRowFilter()})`,
    })
    .from(trackedLinks)
    .where(inArray(trackedLinks.linkId, linkIds))
    .groupBy(trackedLinks.linkId);
  for (const r of rows) {
    if (r.linkId) {
      map.set(r.linkId, {
        clicks: r.clicks,
        scans: r.scans,
        trackedLinkId: r.trackedLinkId ?? null,
      });
    }
  }
  return map;
}

export const linksRouter = new OpenAPIHono<AppEnv>()
  .openapi(createLinkRoute, async (c) => {
    const { db, env } = c.get("container");
    const body = c.req.valid("json");

    try {
      const minted = await mintLink({
        db,
        url: body.url,
        baseUrl: env.API_PUBLIC_URL,
        source: "studio",
        type: body.type,
        slug: body.slug,
        label: body.label,
        campaign: body.campaign,
        distinctId: body.distinctId,
        createdBy: resolveActor(c) ?? undefined,
      });

      const [row] = await db
        .select()
        .from(links)
        .where(eq(links.id, minted.linkId))
        .limit(1);

      if (!row) {
        return c.json({ error: "Mint succeeded but link not found" }, 400);
      }

      return c.json(
        serializeLink(
          row,
          { clicks: 0, scans: 0, trackedLinkId: minted.trackedLinkId },
          env.API_PUBLIC_URL,
        ),
        200,
      );
    } catch (err) {
      if (err instanceof SlugTakenError) {
        return c.json({ error: err.message }, 409);
      }
      const message = err instanceof Error ? err.message : "Mint failed";
      return c.json({ error: message }, 400);
    }
  })
  .openapi(listLinksRoute, async (c) => {
    const { db, env } = c.get("container");
    const { limit, offset, type, includeArchived } = c.req.valid("query");

    const where = and(
      includeArchived ? undefined : isNull(links.archivedAt),
      type ? eq(links.type, type) : undefined,
    );

    const [rows, totalRows] = await Promise.all([
      db
        .select()
        .from(links)
        .where(where)
        .orderBy(desc(links.createdAt))
        .limit(limit)
        .offset(offset),
      db.select({ value: count() }).from(links).where(where),
    ]);

    const agg = await aggregateFor(
      db,
      rows.map((r) => r.id),
    );

    return c.json(
      {
        links: rows.map((row) =>
          serializeLink(row, agg.get(row.id), env.API_PUBLIC_URL),
        ),
        total: totalRows[0]?.value ?? 0,
        limit,
        offset,
      },
      200,
    );
  })
  .openapi(getLinkRoute, async (c) => {
    const { db, env } = c.get("container");
    const { id } = c.req.valid("param");

    const [row] = await db
      .select()
      .from(links)
      .where(eq(links.id, id))
      .limit(1);

    if (!row) {
      return c.json({ error: "Link not found" }, 404);
    }

    // Recent clicks joined via the link's tracked_links rows, newest first,
    // capped. The aggregate gives the summed count + the redirect id.
    const [agg, clickRows] = await Promise.all([
      aggregateFor(db, [id]),
      db
        .select({
          id: linkClicks.id,
          trackedLinkId: linkClicks.trackedLinkId,
          ipAddress: linkClicks.ipAddress,
          userAgent: linkClicks.userAgent,
          clickedAt: linkClicks.clickedAt,
        })
        .from(linkClicks)
        .innerJoin(trackedLinks, eq(linkClicks.trackedLinkId, trackedLinks.id))
        .where(eq(trackedLinks.linkId, id))
        .orderBy(desc(linkClicks.clickedAt))
        .limit(50),
    ]);

    return c.json(
      {
        ...serializeLink(row, agg.get(id), env.API_PUBLIC_URL),
        clicks: clickRows.map((cl) => ({
          id: cl.id,
          trackedLinkId: cl.trackedLinkId,
          ipAddress: cl.ipAddress,
          userAgent: cl.userAgent,
          clickedAt: cl.clickedAt.toISOString(),
        })),
      },
      200,
    );
  })
  .openapi(updateLinkRoute, async (c) => {
    const { db, env } = c.get("container");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");

    // Re-targeting the destination: validate http(s) BEFORE opening the tx so an
    // invalid URL never starts a transaction. Reuses the exact open-redirect
    // guard mintLink applies at create time.
    if (body.originalUrl !== undefined) {
      try {
        assertHttpUrl(body.originalUrl);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Invalid destination URL";
        return c.json({ error: message }, 400);
      }
    }

    const patch: Partial<
      Pick<LinkRow, "label" | "campaign" | "originalUrl" | "slug">
    > & {
      updatedAt: Date;
    } = { updatedAt: new Date() };
    if (body.label !== undefined) patch.label = body.label;
    if (body.campaign !== undefined) patch.campaign = body.campaign;
    if (body.originalUrl !== undefined) patch.originalUrl = body.originalUrl;
    // Slug: string = set/replace (normalized, 409 on conflict below); null =
    // clear, freeing it for reuse.
    if (body.slug !== undefined) {
      if (body.slug === null) {
        patch.slug = null;
      } else {
        try {
          patch.slug = normalizeSlug(body.slug);
        } catch (err) {
          const message = err instanceof Error ? err.message : "Invalid slug";
          return c.json({ error: message }, 400);
        }
      }
    }

    // Both writes in ONE transaction so the two originalUrls can never diverge.
    // CRITICAL: the click redirect reads tracked_links.originalUrl fresh per
    // hit (no cache), NOT links.originalUrl — so re-targeting MUST also update
    // the link's tracked_links rows (scoped by link_id — the managed redirect
    // row, plus the QR scan row once one is minted). The links row is the
    // display/source of truth.
    let updated: LinkRow | null;
    try {
      updated = await db.transaction(async (tx) => {
        const [row] = await tx
          .update(links)
          .set(patch)
          .where(eq(links.id, id))
          .returning();

        // Signal 404 to the caller; returning null (vs throwing) commits an
        // empty tx and avoids bubbling as a 500.
        if (!row) return null;

        if (body.originalUrl !== undefined) {
          await tx
            .update(trackedLinks)
            .set({ originalUrl: body.originalUrl, updatedAt: new Date() })
            .where(eq(trackedLinks.linkId, id));
        }

        return row;
      });
    } catch (err) {
      if (patch.slug && isSlugUniqueViolation(err)) {
        return c.json({ error: new SlugTakenError(patch.slug).message }, 409);
      }
      throw err;
    }

    if (!updated) {
      return c.json({ error: "Link not found" }, 404);
    }

    const agg = await aggregateFor(db, [updated.id]);
    return c.json(
      serializeLink(updated, agg.get(updated.id), env.API_PUBLIC_URL),
      200,
    );
  })
  .openapi(archiveLinkRoute, async (c) => {
    const { db, env } = c.get("container");
    const { id } = c.req.valid("param");

    const archivedAt = new Date();
    // Archive only if not already archived — a second DELETE is a 404, not a
    // silent re-archive. History (link_clicks via tracked_links) survives.
    const [archived] = await db
      .update(links)
      .set({ archivedAt, updatedAt: archivedAt })
      .where(and(eq(links.id, id), isNull(links.archivedAt)))
      .returning();

    if (!archived) {
      return c.json({ error: "Link not found" }, 404);
    }

    const agg = await aggregateFor(db, [archived.id]);
    return c.json(
      serializeLink(archived, agg.get(archived.id), env.API_PUBLIC_URL),
      200,
    );
  });
