import { links, trackedLinks } from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../../app.js";
import { clickSelection, handleTrackedClick } from "./click-pipeline.js";

// The SMS short path — `/s/:code` layered over `/v1/t/c/:id`, mirroring the
// vanity `/l/:slug` route. Mounted at the APP ROOT so the texted URL stays
// short (every character counts against the GSM-7 segment budget); `/s`
// collides with nothing (`/v1`, `/l`, `/studio`, `/docs`, `/api/auth`,
// `/connectors`, webhooks).
const shortRoute = createRoute({
  method: "get",
  path: "/s/:code",
  tags: ["Tracking"],
  summary: "SMS short link redirect",
  request: {
    params: z.object({
      code: z.string(),
    }),
  },
  responses: {
    302: { description: "Redirect to original URL" },
  },
});

// Lenient superset of minted codes (8-char lowercase base32): tolerate a
// hand-retyped code without rejecting future length changes.
const SHORT_CODE_RE = /^[a-z0-9]{4,32}$/;

export const shortLinkRouter = new OpenAPIHono<AppEnv>().openapi(
  shortRoute,
  async (c) => {
    const { code } = c.req.valid("param");
    const { db, env } = c.get("container");

    // Codes are minted lowercase; normalize a cased retype. A malformed code
    // can't match anything — treat it like an unknown link (redirect home),
    // mirroring the vanity route's malformed-slug behavior.
    const normalized = code.trim().toLowerCase();
    if (!SHORT_CODE_RE.test(normalized)) {
      return c.redirect(env.API_PUBLIC_URL, 302);
    }

    // LEFT JOIN links purely to satisfy the shared clickSelection shape —
    // SMS-minted rows have `link_id` NULL (mirrors the UUID route).
    const rows = await db
      .select(clickSelection)
      .from(trackedLinks)
      .leftJoin(links, eq(trackedLinks.linkId, links.id))
      .where(eq(trackedLinks.shortCode, normalized))
      .limit(1);

    const link = rows[0];
    if (!link) {
      return c.redirect(env.API_PUBLIC_URL, 302);
    }

    return handleTrackedClick(c, link);
  },
);
