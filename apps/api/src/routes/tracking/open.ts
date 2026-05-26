import { emailSends } from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { eq, sql } from "drizzle-orm";
import type { AppEnv } from "../../app.js";

const TRANSPARENT_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);

const openRoute = createRoute({
  method: "get",
  path: "/o/:id",
  tags: ["Tracking"],
  summary: "Track email open",
  request: {
    params: z.object({
      id: z.string().uuid(),
    }),
  },
  responses: {
    200: { description: "1x1 transparent GIF" },
  },
});

export const openRouter = new OpenAPIHono<AppEnv>().openapi(
  openRoute,
  async (c) => {
    const { id } = c.req.valid("param");
    const { db } = c.get("container");

    await db
      .update(emailSends)
      .set({
        openedAt: sql`COALESCE(${emailSends.openedAt}, NOW())`,
        updatedAt: new Date(),
      })
      .where(eq(emailSends.id, id));

    return c.body(TRANSPARENT_GIF, 200, {
      "Content-Type": "image/gif",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      Pragma: "no-cache",
      Expires: "0",
    });
  },
);
