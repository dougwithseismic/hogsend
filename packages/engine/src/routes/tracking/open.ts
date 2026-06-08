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
    const { db, hatchet, registry, logger } = c.get("container");

    // First-touch state UPDATE: the `WHERE openedAt IS NULL` sets `openedAt`
    // exactly once (the first open), which is the row-level state we keep. The
    // outbound emit is NO LONGER gated on this — every destination must receive
    // EVERY open (owner decision 1), so the emit below fires per-hit.
    await db
      .update(emailSends)
      .set({
        openedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(emailSends.id, id), isNull(emailSends.openedAt)));

    // Resolve the send context ONCE (off the response path) and feed both the
    // re-ingest and the PER-HIT outbound emit — avoiding a duplicate
    // `resolveEmailSendContext` read on the pixel hot path. NO `dedupeKey`: a
    // NULL dedupe key is distinct in Postgres, so every open creates a fresh
    // delivery to every subscribed destination (per-hit, not first-touch).
    void resolveEmailSendContext(db, id)
      .then(async (ctx) => {
        await pushTrackingEvent({
          db,
          hatchet,
          registry,
          logger,
          event: EMAIL_OPENED,
          emailSendId: id,
          resolvedContext: ctx,
        }).catch((err) => {
          logger.warn("Failed to push open tracking event", {
            emailSendId: id,
            error: err instanceof Error ? err.message : String(err),
          });
        });

        // Only emit when the send-context resolved. A missing emailSends row
        // (orphaned tracked pixel / deleted send) has no userId or recipient to
        // attribute, and a keyed destination (PostHog) would otherwise receive
        // an empty distinct_id. A normal open always resolves a non-null userId.
        if (ctx) {
          await emitOutbound({
            db,
            hatchet,
            logger,
            event: "email.opened",
            payload: {
              emailSendId: id,
              messageId: ctx.messageId ?? null,
              templateKey: ctx.templateKey ?? null,
              userId: ctx.userId ?? null,
              to: ctx.to ?? ctx.userEmail ?? "",
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
