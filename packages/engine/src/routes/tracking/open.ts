import { emailSends } from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, eq, isNull } from "drizzle-orm";
import type { AppEnv } from "../../app.js";
import { emitOutbound } from "../../lib/outbound.js";
import { EMAIL_OPENED } from "../../lib/tracking-event-names.js";
import {
  pushTrackingEvent,
  resolveEmailSendContext,
} from "../../lib/tracking-events.js";

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
    const {
      db,
      hatchet,
      registry,
      logger,
      analytics: posthog,
    } = c.get("container");

    // First-touch gate: the `WHERE openedAt IS NULL` makes this UPDATE return a
    // row ONLY on the FIRST open. `.returning({ id })` lets the outbound emit fire
    // exactly once — first-party is the SINGLE emitter for `email.opened` (the
    // provider-webhook echo in the mailer is suppressed — risk 4).
    const opened = await db
      .update(emailSends)
      .set({
        openedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(emailSends.id, id), isNull(emailSends.openedAt)))
      .returning({ id: emailSends.id });

    // Resolve the send context ONCE (off the response path) and feed both the
    // re-ingest (every open) and the first-touch outbound emit (first open
    // only) — avoiding a duplicate `resolveEmailSendContext` read on the pixel
    // hot path. `dedupeKey` = `email.opened:<id>` is defence-in-depth alongside
    // the first-touch gate (`opened.length > 0`); first-party is the SINGLE
    // emitter for `email.opened` (the provider-webhook echo is suppressed).
    const isFirstOpen = opened.length > 0;
    void resolveEmailSendContext(db, id)
      .then(async (ctx) => {
        await pushTrackingEvent({
          db,
          hatchet,
          registry,
          logger,
          posthog,
          event: EMAIL_OPENED,
          emailSendId: id,
          resolvedContext: ctx,
        }).catch((err) => {
          logger.warn("Failed to push open tracking event", {
            emailSendId: id,
            error: err instanceof Error ? err.message : String(err),
          });
        });

        if (isFirstOpen) {
          await emitOutbound({
            db,
            hatchet,
            logger,
            event: "email.opened",
            dedupeKey: `email.opened:${id}`,
            payload: {
              emailSendId: id,
              resendId: ctx?.resendId ?? null,
              templateKey: ctx?.templateKey ?? null,
              userId: ctx?.userId ?? null,
              to: ctx?.to ?? ctx?.userEmail ?? "",
              at: new Date().toISOString(),
            },
          });
        }
      })
      .catch(logger.warn);

    return c.body(TRANSPARENT_GIF, 200, {
      "Content-Type": "image/gif",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      Pragma: "no-cache",
      Expires: "0",
    });
  },
);
