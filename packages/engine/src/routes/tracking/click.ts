import { emailSends, linkClicks, trackedLinks } from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { AppEnv } from "../../app.js";
import { generateIdentityToken } from "../../lib/identity-token.js";
import { emitOutbound } from "../../lib/outbound.js";
import { EMAIL_LINK_CLICKED } from "../../lib/tracking-event-names.js";
import {
  pushTrackingEvent,
  resolveEmailSendContext,
} from "../../lib/tracking-events.js";
import { confirmSemanticClickTask } from "../../workflows/confirm-semantic-click.js";

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
        distinctId: trackedLinks.distinctId,
        source: trackedLinks.source,
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

    // The linkClicks insert + clickCount increment stay UNCONDITIONAL — every
    // tracked link counts clicks, email or not.
    //
    // First-touch state UPDATE: the `WHERE clickedAt IS NULL` sets `clickedAt`
    // exactly once (the first click), which is the row-level state we keep. The
    // outbound emit is NO LONGER gated on this — every destination must receive
    // EVERY click (owner decision 1), so the emit below fires per-hit. The
    // emailSends update is GATED on `emailSendId != null` (MF-6): a non-email
    // link has no send row to mark. This was previously safe-by-accident
    // (`WHERE id = NULL` matches nothing) — the gate makes it explicit.
    const emailSendId = link.emailSendId;
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
      ...(emailSendId
        ? [
            db
              .update(emailSends)
              .set({
                clickedAt: new Date(),
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(emailSends.id, emailSendId),
                  isNull(emailSends.clickedAt),
                ),
              ),
          ]
        : []),
    ]);

    const { hatchet, registry, logger } = c.get("container");

    // SEMANTIC link: the click is a PROVISIONAL answer. Confirmation is
    // deferred past the scanner-burst window (a Hatchet task) so the gate can
    // see the WHOLE burst — an inline check could never suppress a scanner's
    // first click. The task claims the send's answer slot (first answer wins)
    // and emits the consumer event + email.action outbound. GATED on
    // `emailSendId != null` (MF-6): the confirm task is email-semantic (it
    // claims a send's answer slot + emits `email.action`), so a non-email
    // semantic link would have no send to confirm against.
    if (link.event && emailSendId) {
      void confirmSemanticClickTask
        .runNoWait({
          trackedLinkId: link.id,
          clickedAt: new Date().toISOString(),
        })
        .catch((err: unknown) => {
          logger.warn("Failed to enqueue semantic click confirmation", {
            linkId: link.id,
            event: link.event,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }

    // Cross-device identity stitch (opt-in): append a short-lived signed
    // `hs_t` token to the destination so the landing site can fold its own anon
    // session INTO the subject at `/v1/t/identify`. Two mint sources by link
    // type (§6.5): a stitch-bearing NON-email link mints from its own
    // `distinct_id` (`src: "<source>:<id>"`); an EMAIL link mints from the
    // resolved send context; a BROADCAST link (no `distinct_id`, no send) mints
    // nothing. The token is minted at CLICK time only — never stored on the
    // shareable `/v1/t/c/:id` artifact (§6.3). The awaited send resolve is
    // shared with the async chain below so the read still happens once.
    let redirectUrl = link.originalUrl;
    let preResolved: Awaited<
      ReturnType<typeof resolveEmailSendContext>
    > | null = null;
    let preResolvedSet = false;
    if (env.TRACKING_IDENTITY_TOKEN) {
      let tokenDistinctId: string | null = null;
      let tokenSrc: string | null = null;
      if (link.distinctId) {
        // Stitch-bearing non-email link: the subject is the link's own
        // `distinct_id` (canonical key). No send resolve needed.
        tokenDistinctId = link.distinctId;
        tokenSrc = `${link.source ?? "link"}:${link.id}`;
      } else if (emailSendId) {
        // Email link: resolve the recipient's canonical key from the send row.
        preResolved = await resolveEmailSendContext(db, emailSendId);
        preResolvedSet = true;
        if (preResolved?.userId) {
          tokenDistinctId = preResolved.userId;
          tokenSrc = `email:${emailSendId}`;
        }
      }
      // else: broadcast link (no distinctId, no send) — mint nothing.

      if (tokenDistinctId && tokenSrc) {
        try {
          const url = new URL(link.originalUrl);
          url.searchParams.set(
            "hs_t",
            generateIdentityToken({
              secret: env.BETTER_AUTH_SECRET,
              distinctId: tokenDistinctId,
              src: tokenSrc,
              emailSendId: emailSendId ?? undefined,
            }),
          );
          redirectUrl = url.toString();
        } catch {
          // Unparseable destination — redirect untouched rather than break it.
          redirectUrl = link.originalUrl;
        }
      }
    }

    // PER-HIT outbound emit, off the response path. EMAIL links re-ingest the
    // first-party `email.link_clicked` event (journey routing + userEvents) and
    // emit `email.clicked`; NON-email links emit `link.clicked` instead — never
    // a malformed `email.clicked` (MF-missing #3). NO `dedupeKey`: a NULL dedupe
    // key is distinct in Postgres, so every click creates a fresh delivery to
    // every subscribed destination (per-hit, not first-touch).
    if (emailSendId) {
      void (
        preResolvedSet
          ? Promise.resolve(preResolved)
          : resolveEmailSendContext(db, emailSendId)
      )
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
        })
        .catch(logger.warn);
    } else {
      // Non-email tracked link: emit the catalogued `link.clicked` (NOT
      // `email.clicked`). `userId` is the link's stitch subject when
      // identity-bearing, else null for a broadcast link. No re-ingest — the
      // first-party `email.link_clicked` bus event is email-semantic.
      void emitOutbound({
        db,
        hatchet,
        logger,
        event: "link.clicked",
        payload: {
          linkId: link.id,
          source: link.source ?? null,
          userId: link.distinctId ?? null,
          emailSendId: null,
          messageId: null,
          linkUrl: link.originalUrl,
          at: new Date().toISOString(),
        },
      }).catch(logger.warn);
    }

    return c.redirect(redirectUrl, 302);
  },
);
