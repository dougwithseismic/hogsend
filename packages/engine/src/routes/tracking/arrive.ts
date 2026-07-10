import { linkClicks, links, trackedLinks } from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, eq, isNull } from "drizzle-orm";
import type { AppEnv } from "../../app.js";
import {
  collidesWithIdentified,
  PublishableAnonymousMergeError,
} from "../../lib/contacts.js";
import { ingestEvent } from "../../lib/ingestion.js";
import { emitOutbound } from "../../lib/outbound.js";
import { LINK_ARRIVED } from "../../lib/tracking-event-names.js";
import {
  InvalidUserTokenError,
  verifyUserToken,
} from "../../lib/user-token.js";

/**
 * Arrival attribution: the landing page reports "a visitor arrived from
 * tracked hit `ref`" with the visitor's identity evidence. `ref` is the
 * `hs_ref=<link_clicks.id>` the redirect appended (opt-in per link,
 * `links.append_ref`). Joins visitor → that specific scan/click, stamps the
 * click row (first-write-wins), and emits the journey-triggerable
 * `link.arrived` event.
 *
 * TRUST MODEL (mirrors the events route + feed recipient — see
 * `gatePublishableIdentity` and `resolveFeedRecipient`):
 *  - `userToken` (HMAC, BETTER_AUTH_SECRET) is the ONLY way a browser asserts
 *    a concrete userId. `visitor_kind = 'token'`.
 *  - a raw `anonymousId` is PROVENANCE-ONLY: rejected if it collides with an
 *    identified contact's canonical key (`collidesWithIdentified`), and the
 *    bus ingest runs under `restrictToAnonymous` — it can never attach to /
 *    merge into an identified contact. `visitor_kind = 'anon'`.
 *  - a bare asserted email/userId is not even in the schema.
 *  - INVARIANT: nothing the ref resolves to (above all `links.distinct_id`)
 *    ever enters the contact resolver as a subject — identity inputs come
 *    ONLY from the token or the clamped anon id.
 *
 * NOTE: with a valid userToken this is the first `/v1/t/*` route that writes
 * journey-triggering events for an identified subject. That authority is the
 * token itself (the same holder could call `/v1/events`); possession of `ref`
 * only selects WHICH click row gets attributed.
 *
 * IDEMPOTENCY: the ingest subject is ALWAYS read from the stamped row, never
 * the current request — so a replayed ref is a self-healing retry (the
 * `link:arrived:<ref>` idempotencyKey caps it at one event ever, for the
 * originally stamped visitor), not a way to re-attribute or double-fire.
 *
 * ANTI-ORACLE: every outcome — success, unknown ref, non-participating link,
 * already stamped, invalid token, collision skip, no identity — returns the
 * SAME `200 {"ok":true}`. An unauthenticated caller learns nothing about
 * contacts or refs. 400 only for a malformed body.
 */
const arriveRoute = createRoute({
  method: "post",
  path: "/arrive",
  tags: ["Tracking"],
  summary: "Report a landing-page arrival from a tracked link hit",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            // The `hs_ref` value from the landing URL.
            ref: z.string().uuid(),
            // The visitor's OWN browser anon id (`hs_anon_id`) — provenance
            // only, clamped.
            anonymousId: z.string().min(1).max(200).optional(),
            // Server-minted HMAC token binding a userId — the only way a
            // browser asserts an identified visitor. Wins over anonymousId.
            userToken: z.string().min(1).max(2048).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Acknowledged (uniform across all outcomes)",
      content: {
        "application/json": { schema: z.object({ ok: z.literal(true) }) },
      },
    },
    400: { description: "Malformed body" },
  },
});

export const arriveRouter = new OpenAPIHono<AppEnv>().openapi(
  arriveRoute,
  async (c) => {
    const { ref, anonymousId, userToken } = c.req.valid("json");
    const { db, env, logger, hatchet, registry, analytics } =
      c.get("container");
    const ok = () => c.json({ ok: true as const }, 200);

    // Resolve the hit + its link, join-gated on the opt-in: a ref for a
    // non-participating link is only obtainable out-of-band → no-op.
    const rows = await db
      .select({
        visitorDistinctId: linkClicks.visitorDistinctId,
        visitorKind: linkClicks.visitorKind,
        destinationUrl: linkClicks.destinationUrl,
        trackedLinkId: trackedLinks.id,
        source: trackedLinks.source,
        linkId: links.id,
        campaign: links.campaign,
      })
      .from(linkClicks)
      .innerJoin(trackedLinks, eq(linkClicks.trackedLinkId, trackedLinks.id))
      .innerJoin(
        links,
        and(eq(trackedLinks.linkId, links.id), eq(links.appendRef, true)),
      )
      .where(eq(linkClicks.id, ref))
      .limit(1);
    const hit = rows[0];
    if (!hit) return ok();

    // Resolve the visitor evidence. INVARIANT: identity comes ONLY from here —
    // never from anything the ref resolved to.
    let claimId: string | null = null;
    let claimKind: "token" | "anon" | null = null;
    if (userToken) {
      try {
        claimId = verifyUserToken({
          token: userToken,
          secret: env.BETTER_AUTH_SECRET,
        }).userId;
        claimKind = "token";
      } catch (err) {
        if (err instanceof InvalidUserTokenError) {
          // Background beacon — nothing for the caller to do differently, and
          // a distinguishable failure would add oracle surface.
          logger.info("arrive: invalid userToken (no-op)", { ref });
          return ok();
        }
        throw err;
      }
    } else if (anonymousId) {
      // The stamp guard: an "anon id" that is really an identified contact's
      // canonical key would forge "that person arrived here" in the stamp
      // even though the clamped ingest would suppress the event.
      if (await collidesWithIdentified(db, anonymousId)) {
        logger.info("arrive: anonymousId collides with identified (no-op)", {
          ref,
        });
        return ok();
      }
      claimId = anonymousId;
      claimKind = "anon";
    } else {
      return ok();
    }

    // First-write-wins stamp; on a replay, read back the ORIGINAL stamp — the
    // ingest below always runs with the stamped identity, never the current
    // request's, so a replay is a self-healing retry, not a re-attribution.
    const [fresh] = await db
      .update(linkClicks)
      .set({
        visitorDistinctId: claimId,
        visitorKind: claimKind,
        arrivedAt: new Date(),
      })
      .where(and(eq(linkClicks.id, ref), isNull(linkClicks.visitorDistinctId)))
      .returning({
        visitorDistinctId: linkClicks.visitorDistinctId,
        visitorKind: linkClicks.visitorKind,
      });

    const stamp =
      fresh ??
      (hit.visitorDistinctId
        ? {
            visitorDistinctId: hit.visitorDistinctId,
            visitorKind: hit.visitorKind,
          }
        : // Raced another arrive between our select and update — re-read.
          (
            await db
              .select({
                visitorDistinctId: linkClicks.visitorDistinctId,
                visitorKind: linkClicks.visitorKind,
              })
              .from(linkClicks)
              .where(eq(linkClicks.id, ref))
              .limit(1)
          )[0]);
    if (!stamp?.visitorDistinctId) return ok();
    const isToken = stamp.visitorKind === "token";

    // Bus ingest from the STAMPED identity. `link:arrived:<ref>` (no time
    // bucket — once per ref forever): the user_events unique index +
    // compensating delete make replays converge on exactly one event.
    try {
      const result = await ingestEvent({
        db,
        registry,
        hatchet,
        logger,
        analytics,
        restrictToAnonymous: !isToken,
        event: {
          event: LINK_ARRIVED,
          ...(isToken
            ? { userId: stamp.visitorDistinctId }
            : { anonymousId: stamp.visitorDistinctId }),
          eventProperties: {
            linkId: hit.linkId,
            trackedLinkId: hit.trackedLinkId,
            ref,
            source: hit.source,
            campaign: hit.campaign,
            linkUrl: hit.destinationUrl,
            visitorKind: stamp.visitorKind,
          },
          source: "tracking",
          idempotencyKey: `link:arrived:${ref}`,
        },
      });

      // Outbound only on the FRESH store — outbound has no dedupe of its own,
      // so this is what keeps webhooks at one delivery per ref.
      if (result.stored) {
        void emitOutbound({
          db,
          hatchet,
          logger,
          event: "link.arrived",
          payload: {
            linkId: hit.linkId,
            trackedLinkId: hit.trackedLinkId,
            ref,
            source: hit.source,
            campaign: hit.campaign,
            userId: isToken ? stamp.visitorDistinctId : null,
            anonymousId: isToken ? null : stamp.visitorDistinctId,
            visitorKind: isToken ? "token" : "anon",
            linkUrl: hit.destinationUrl,
            at: new Date().toISOString(),
          },
        }).catch(logger.warn);
      }
    } catch (err) {
      if (err instanceof PublishableAnonymousMergeError) {
        // The anon id became identified between the stamp guard and the
        // clamped resolve (race) — suppress the event, keep the stamp, 200.
        logger.info("arrive: clamped anon ingest suppressed", { ref });
        return ok();
      }
      // Transient ingest failure — the stamp is durable and a replayed ref
      // self-heals, so never fail the beacon.
      logger.warn("arrive: ingest failed (stamp kept; replay heals)", {
        ref,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return ok();
  },
);
