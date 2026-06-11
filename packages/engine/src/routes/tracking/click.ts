import { emailSends, linkClicks, trackedLinks } from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, countDistinct, eq, gte, isNull, sql } from "drizzle-orm";
import type { AppEnv } from "../../app.js";
import { emitOutbound } from "../../lib/outbound.js";
import { EMAIL_LINK_CLICKED } from "../../lib/tracking-event-names.js";
import {
  pushTrackingEvent,
  resolveEmailSendContext,
} from "../../lib/tracking-events.js";

// Scanner-burst window: SafeLinks/Proofpoint-style scanners follow EVERY link
// in an email within seconds of delivery; humans don't. When this many DISTINCT
// links of one send are clicked inside the window, the semantic emit is
// suppressed (the generic email.link_clicked still fires per hit).
const SEMANTIC_BURST_WINDOW_MS = 30_000;
const SEMANTIC_BURST_DISTINCT_LINKS = 3;

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
        event: trackedLinks.event,
        eventProperties: trackedLinks.eventProperties,
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

    // First-touch state UPDATE: the `WHERE clickedAt IS NULL` sets `clickedAt`
    // exactly once (the first click), which is the row-level state we keep. The
    // outbound emit is NO LONGER gated on this — every destination must receive
    // EVERY click (owner decision 1), so the emit below fires per-hit.
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

    // Resolve the send context ONCE (off the response path) and feed both the
    // re-ingest and the PER-HIT outbound emit — avoiding a duplicate
    // `resolveEmailSendContext` read on the click hot path. NO `dedupeKey`: a
    // NULL dedupe key is distinct in Postgres, so every click creates a fresh
    // delivery to every subscribed destination (per-hit, not first-touch).
    const emailSendId = link.emailSendId;
    void resolveEmailSendContext(db, emailSendId)
      .then(async (ctx) => {
        await pushTrackingEvent({
          db,
          hatchet,
          registry,
          logger,
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

        // Only emit when the send-context resolved. A missing emailSends row
        // (orphaned tracked link / deleted send) has no userId or recipient to
        // attribute, and a keyed destination (PostHog) would otherwise receive
        // an empty distinct_id. A normal click always resolves a non-null userId.
        if (ctx) {
          await emitOutbound({
            db,
            hatchet,
            logger,
            event: "email.clicked",
            payload: {
              emailSendId,
              messageId: ctx.messageId ?? null,
              templateKey: ctx.templateKey ?? null,
              userId: ctx.userId ?? null,
              to: ctx.to ?? ctx.userEmail ?? "",
              at: new Date().toISOString(),
              linkUrl: link.originalUrl,
              linkId: link.id,
            },
          });
        }

        // SEMANTIC link: this click MEANS something (an in-email answer).
        // First answer per (send, event name) wins — the `sem:` idempotency
        // key dedupes inside ingestEvent BEFORE the Hatchet push, so journeys
        // and destinations see at most one answer per send.
        if (link.event && ctx) {
          // Scanner-burst suppression: if several DISTINCT links of this send
          // were clicked within the window, treat the hit as a scanner and
          // skip the semantic emit (the raw click is already recorded above).
          const windowStart = new Date(Date.now() - SEMANTIC_BURST_WINDOW_MS);
          const burst = await db
            .select({ n: countDistinct(linkClicks.trackedLinkId) })
            .from(linkClicks)
            .innerJoin(
              trackedLinks,
              eq(linkClicks.trackedLinkId, trackedLinks.id),
            )
            .where(
              and(
                eq(trackedLinks.emailSendId, emailSendId),
                gte(linkClicks.clickedAt, windowStart),
              ),
            );
          const distinctLinks = burst[0]?.n ?? 0;
          if (distinctLinks >= SEMANTIC_BURST_DISTINCT_LINKS) {
            logger.warn("Semantic emit suppressed: scanner-like click burst", {
              emailSendId,
              linkId: link.id,
              event: link.event,
              distinctLinks,
            });
            return;
          }

          const result = await pushTrackingEvent({
            db,
            hatchet,
            registry,
            logger,
            event: link.event,
            emailSendId,
            properties: {
              ...(link.eventProperties ?? {}),
              linkId: link.id,
            },
            resolvedContext: ctx,
            idempotencyKey: `sem:${emailSendId}:${link.event}`,
          });

          // stored=false means a prior click already answered for this send —
          // no outbound either, so destinations mirror journey semantics.
          if (result?.stored) {
            // Mark THIS link as the recorded answer (observability now, the
            // provisional-then-confirm anchor later). `IS NULL` keeps it
            // idempotent under concurrent clicks.
            await db
              .update(trackedLinks)
              .set({ semanticEmittedAt: new Date(), updatedAt: new Date() })
              .where(
                and(
                  eq(trackedLinks.id, link.id),
                  isNull(trackedLinks.semanticEmittedAt),
                ),
              );

            await emitOutbound({
              db,
              hatchet,
              logger,
              event: "email.action",
              payload: {
                event: link.event,
                properties: link.eventProperties ?? null,
                emailSendId,
                templateKey: ctx.templateKey ?? null,
                userId: ctx.userId ?? null,
                to: ctx.to ?? ctx.userEmail ?? "",
                at: new Date().toISOString(),
                linkId: link.id,
                linkUrl: link.originalUrl,
              },
            });
          }
        }
      })
      .catch(logger.warn);

    return c.redirect(link.originalUrl, 302);
  },
);
