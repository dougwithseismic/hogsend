import { emailSends, linkClicks, trackedLinks } from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { AppEnv } from "../../app.js";
import { emitOutbound } from "../../lib/outbound.js";
import { EMAIL_LINK_CLICKED } from "../../lib/tracking-event-names.js";
import {
  pushTrackingEvent,
  resolveEmailSendContext,
} from "../../lib/tracking-events.js";

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

    // The `clickedAt` first-touch UPDATE is split OUT of the Promise.all so it can
    // `.returning({ id })` — the `WHERE clickedAt IS NULL` makes a row come back
    // ONLY on the first click, which gates the outbound `email.clicked` emit.
    const [, , clicked] = await Promise.all([
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
        )
        .returning({ id: emailSends.id }),
    ]);

    const {
      hatchet,
      registry,
      logger,
      analytics: posthog,
    } = c.get("container");

    // Resolve the send context ONCE (off the response path) and feed both the
    // re-ingest (every click) and the first-touch outbound emit (first click
    // only) — avoiding a duplicate `resolveEmailSendContext` read on the click
    // hot path. `dedupeKey` = `email.clicked:<emailSendId>` is defence-in-depth
    // alongside the first-touch gate (`clicked.length > 0`); first-party is the
    // SINGLE emitter for `email.clicked` (the provider-webhook echo is suppressed).
    const emailSendId = link.emailSendId;
    const isFirstClick = clicked.length > 0;
    void resolveEmailSendContext(db, emailSendId)
      .then(async (ctx) => {
        await pushTrackingEvent({
          db,
          hatchet,
          registry,
          logger,
          posthog,
          event: EMAIL_LINK_CLICKED,
          emailSendId,
          properties: { linkUrl: link.originalUrl, linkId: link.id },
          resolvedContext: ctx,
        }).catch((err) => {
          logger.warn("Failed to push click tracking event", {
            linkId: link.id,
            error: err instanceof Error ? err.message : String(err),
          });
        });

        if (isFirstClick) {
          await emitOutbound({
            db,
            hatchet,
            logger,
            event: "email.clicked",
            dedupeKey: `email.clicked:${emailSendId}`,
            payload: {
              emailSendId,
              resendId: ctx?.resendId ?? null,
              templateKey: ctx?.templateKey ?? null,
              userId: ctx?.userId ?? null,
              to: ctx?.to ?? ctx?.userEmail ?? "",
              at: new Date().toISOString(),
              linkUrl: link.originalUrl,
              linkId: link.id,
            },
          });
        }
      })
      .catch(logger.warn);

    return c.redirect(link.originalUrl, 302);
  },
);
