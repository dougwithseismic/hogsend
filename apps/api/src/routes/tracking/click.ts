import { emailSends, linkClicks, trackedLinks } from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { AppEnv } from "../../app.js";
import { pushTrackingEvent } from "../../lib/tracking-events.js";

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
      .select({
        id: trackedLinks.id,
        originalUrl: trackedLinks.originalUrl,
        emailSendId: trackedLinks.emailSendId,
      })
      .from(trackedLinks)
      .where(eq(trackedLinks.id, id))
      .limit(1);

    const link = rows[0];
    if (!link) {
      return c.redirect(env.API_PUBLIC_URL, 302);
    }

    const ip =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
      c.req.header("x-real-ip") ??
      null;
    const userAgent = c.req.header("user-agent") ?? null;

    await Promise.all([
      db.insert(linkClicks).values({
        trackedLinkId: link.id,
        ipAddress: ip,
        userAgent,
      }),
      db
        .update(trackedLinks)
        .set({
          clickCount: sql`${trackedLinks.clickCount} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(trackedLinks.id, link.id)),
      db
        .update(emailSends)
        .set({
          clickedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(emailSends.id, link.emailSendId),
            isNull(emailSends.clickedAt),
          ),
        ),
    ]);

    const { hatchet, registry, logger } = c.get("container");
    const posthog = c.get("container").env.POSTHOG_API_KEY
      ? (await import("../../lib/posthog.js")).getPostHog()
      : undefined;

    pushTrackingEvent({
      db,
      hatchet,
      registry,
      logger,
      posthog,
      event: "email.link_clicked",
      emailSendId: link.emailSendId,
      properties: { linkUrl: link.originalUrl, linkId: link.id },
    }).catch((err) => {
      logger.warn("Failed to push click tracking event", {
        linkId: link.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return c.redirect(link.originalUrl, 302);
  },
);
