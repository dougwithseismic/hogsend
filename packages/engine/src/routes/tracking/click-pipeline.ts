import { randomUUID } from "node:crypto";
import { emailSends, linkClicks, links, trackedLinks } from "@hogsend/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Context } from "hono";
import type { AppEnv } from "../../app.js";
import { isBotOrPrefetch } from "../../lib/bot-prefetch.js";
import { generateIdentityToken } from "../../lib/identity-token.js";
import { emitOutbound } from "../../lib/outbound.js";
import { EMAIL_LINK_CLICKED } from "../../lib/tracking-event-names.js";
import {
  pushLinkClickEvent,
  pushTrackingEvent,
  resolveEmailSendContext,
} from "../../lib/tracking-events.js";
import { confirmSemanticClickTask } from "../../workflows/confirm-semantic-click.js";

// The one SELECT shape the click pipeline needs, shared by every resolver:
// the UUID route (`/v1/t/c/:id`, tracked_links LEFT JOIN links) and the
// vanity route (`/l/:slug`, links INNER JOIN tracked_links).
export const clickSelection = {
  id: trackedLinks.id,
  originalUrl: trackedLinks.originalUrl,
  emailSendId: trackedLinks.emailSendId,
  distinctId: trackedLinks.distinctId,
  source: trackedLinks.source,
  // `event` gates the semantic-confirm dispatch; the confirm task re-reads the
  // row by id, so `eventProperties` is deliberately NOT selected here.
  event: trackedLinks.event,
  // Managed-link provenance (NULL for email-rewritten links, whose
  // `tracked_links.link_id` is NULL). `linkId` is the durable `links.id`
  // a journey filters on; it rides ONLY the bus re-ingest (A5), never the
  // unchanged outbound payloads which keep `trackedLinks.id` as `linkId`.
  linkId: links.id,
  campaign: links.campaign,
  linkType: links.type,
  // Arrival attribution opt-in: append `hs_ref=<click id>` to the redirect.
  appendRef: links.appendRef,
};

export type ResolvedClickLink = {
  id: string;
  originalUrl: string;
  emailSendId: string | null;
  distinctId: string | null;
  source: string | null;
  event: string | null;
  linkId: string | null;
  campaign: string | null;
  linkType: string | null;
  appendRef: boolean | null;
};

/**
 * The full click pipeline for an already-resolved tracked link: record the
 * hit, mark first-touch email state, defer semantic confirmation, mint the
 * opt-in `hs_t` identity token, emit the per-hit outbound + bus events, and
 * 302 to the destination. Route handlers only differ in HOW they resolve the
 * row (UUID vs vanity slug) — everything downstream is identical.
 */
export async function handleTrackedClick(
  c: Context<AppEnv>,
  link: ResolvedClickLink,
): Promise<Response> {
  const { db, env } = c.get("container");

  const ip =
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    c.req.header("x-real-ip") ??
    null;
  const userAgent = c.req.header("user-agent") ?? null;

  // Unfurl-bot / prefetch detection. A link-preview bot (Discord/Slack/…)
  // auto-fetches a DM'd link BEFORE a human clicks; we still record the click
  // + 302, but must NOT re-ingest it onto the journey bus (it would phantom
  // enroll the recipient). Affects ONLY the non-email bus re-ingest below.
  const isBot = isBotOrPrefetch({
    userAgent,
    purpose: c.req.header("purpose"),
    xPurpose: c.req.header("x-purpose"),
    xMozPrefetch: c.req.header("x-moz"),
    secPurpose: c.req.header("sec-purpose"),
  });

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
  // Pre-generate the click id: it is BOTH the row PK and (when the link opts
  // in) the `hs_ref` arrival reference appended to the redirect. The insert is
  // awaited before the redirect, so the ref always resolves.
  const clickId = randomUUID();
  const emailSendId = link.emailSendId;
  await Promise.all([
    db.insert(linkClicks).values({
      id: clickId,
      trackedLinkId: link.id,
      ipAddress: ip,
      userAgent,
      // Per-hit destination provenance: after a re-target, stats stay
      // attributable to whichever destination THIS hit actually went to.
      // The raw target, never the hs_t/hs_ref-decorated variant.
      destinationUrl: link.originalUrl,
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
              and(eq(emailSends.id, emailSendId), isNull(emailSends.clickedAt)),
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
  let preResolved: Awaited<ReturnType<typeof resolveEmailSendContext>> | null =
    null;
  let preResolvedSet = false;
  let identityToken: string | null = null;
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
      identityToken = generateIdentityToken({
        secret: env.BETTER_AUTH_SECRET,
        distinctId: tokenDistinctId,
        src: tokenSrc,
        emailSendId: emailSendId ?? undefined,
      });
    }
  }

  // ONE URL-build pass for every appended param — two separate
  // `new URL(link.originalUrl)` passes would silently drop the other param.
  // `hs_ref` is the ARRIVAL reference (opt-in per link): the raw click id the
  // landing page reports back to POST /v1/t/arrive. Provenance, not identity —
  // never confuse it with `hs_t`. Reserved query params on destinations:
  // `hs_t`, `hs_ref` (both overwritten if already present).
  if (identityToken || link.appendRef) {
    try {
      const url = new URL(link.originalUrl);
      if (identityToken) url.searchParams.set("hs_t", identityToken);
      if (link.appendRef) url.searchParams.set("hs_ref", clickId);
      redirectUrl = url.toString();
    } catch {
      // Unparseable destination — redirect untouched rather than break it.
      redirectUrl = link.originalUrl;
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

    // BUS re-ingest: the first-party `link.clicked` event for a NON-email
    // managed link, so journeys can trigger / `ctx.waitForEvent` on a click of
    // a SPECIFIC managed link (filter by `linkId`/`campaign`). GATED on:
    //  • `!isBot` — an unfurl/prefetch bot fetched the link, not a human.
    //  • `link.distinctId` — a broadcast/public link carries no person, and
    //    `resolveOrCreateContact` THROWS on a zero-key event. Personal links
    //    only; the resolved subject is the survivor contact (not the raw
    //    mint key). Per-second idempotencyKey dedupes the userEvents INSERT on
    //    retry only — `entryLimit` is the journey-level throttle.
    if (!isBot && link.distinctId) {
      void pushLinkClickEvent({
        db,
        hatchet,
        registry,
        logger,
        linkId: link.linkId ?? null,
        trackedLinkId: link.id,
        campaign: link.campaign ?? null,
        source: link.source ?? null,
        linkType: link.linkType ?? null,
        linkUrl: link.originalUrl,
        distinctId: link.distinctId,
        idempotencyKey: `link:click:${link.id}:${Math.floor(
          Date.now() / 1000,
        )}`,
      }).catch(logger.warn);
    }
  }

  return c.redirect(redirectUrl, 302);
}
