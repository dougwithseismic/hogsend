import { links, trackedLinks } from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../../app.js";
import { clickSelection, handleTrackedClick } from "./click-pipeline.js";

const clickRoute = createRoute({
  method: "get",
  path: "/c/:id",
  tags: ["Tracking"],
  summary: "Track link click and redirect",
  request: {
    params: z.object({
      id: z.string().uuid(),
    }),
  },
  responses: {
    302: { description: "Redirect to original URL" },
    404: { description: "Link not found" },
  },
});

export const clickRouter = new OpenAPIHono<AppEnv>().openapi(
  clickRoute,
  async (c) => {
    const { id } = c.req.valid("param");
    const { db, env } = c.get("container");

    const rows = await db
      .select(clickSelection)
      .from(trackedLinks)
      .leftJoin(links, eq(trackedLinks.linkId, links.id))
      .where(eq(trackedLinks.id, id))
      .limit(1);

    const link = rows[0];
    if (!link) {
      return c.redirect(env.API_PUBLIC_URL, 302);
    }

    return handleTrackedClick(c, link);
  },
);
