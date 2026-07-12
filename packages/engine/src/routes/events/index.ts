import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import { PublishableAnonymousMergeError } from "../../lib/contacts.js";
import { ingestEvent } from "../../lib/ingestion.js";
import { applyListMembership } from "../../lib/preferences.js";
import { errorSchema } from "../../lib/schemas.js";
import { gatePublishableIdentity, listMembershipError } from "../_shared.js";

const eventRequestSchema = z.object({
  name: z.string().min(1),
  email: z.string().email().optional(),
  userId: z.string().min(1).optional(),
  // §4: the caller's analytics anon id (e.g. posthog-js `get_distinct_id()`).
  // 2nd in the resolver's key precedence (`external → email → anonymous →
  // discord`), so when no `external_id` is attached the contact's canonical key
  // BECOMES this value — the browser's own anon events and the server's captures
  // then land on ONE analytics person with zero merge calls. An EXTRA, never a
  // third identity arm: `requireIdentity` still requires email or userId
  // (anon-only public ingest is an abuse vector).
  anonymousId: z.string().min(1).max(200).optional(),
  eventProperties: z.record(z.string(), z.unknown()).optional(),
  contactProperties: z.record(z.string(), z.unknown()).optional(),
  // The event's monetary worth (order total, deal value). First-class — lands
  // on `user_events.value`, the column revenue rollups, conversion definitions,
  // and attribution credits read. Negative = refunds/adjustments.
  value: z.number().finite().optional(),
  // ISO-4217 alpha code for `value` (uppercased at ingest). Ignored without
  // `value`.
  currency: z
    .string()
    .regex(/^[A-Za-z]{3}$/)
    .optional(),
  lists: z.record(z.string(), z.boolean()).optional(),
  idempotencyKey: z.string().optional(),
  timestamp: z.string().datetime().optional(),
  // Publishable-key identity assertion (§Phase 1). A pk_ key is anon-only
  // unless it presents a server-minted `userToken` proving the claimed `userId`.
  // Ignored on the secret-key path (which uses `requireIdentity`).
  userToken: z.string().optional(),
});

const eventResponseSchema = z.object({
  stored: z.boolean(),
  exits: z.array(
    z.object({
      journeyId: z.string(),
      stateId: z.string(),
      exited: z.boolean(),
    }),
  ),
  // The contact's canonical key (`external_id ?? anonymous_id ?? id`) — the
  // same key outbound destinations and `hs_t` identity tokens carry, so the
  // caller can `identify()` its analytics session against the contact without
  // any PII round-trip.
  contactKey: z.string(),
  // Present only when the event was durably ingested but the (non-atomic,
  // post-ingest) list-membership write failed. The ingest itself succeeded —
  // surfaced as a warning on a 202, not a 400 that conflates "nothing happened"
  // with "event happened, lists failed" (and would tempt a retry double-ingest).
  listsError: z.string().optional(),
});

const eventRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Events"],
  summary: "Ingest an event",
  description:
    "Stores the event (with eventProperties), merges contactProperties onto the contact, pushes to Hatchet for journey routing, processes exit conditions, and optionally writes list membership. The `Idempotency-Key` header takes precedence over the body field.",
  request: {
    body: {
      content: {
        "application/json": { schema: eventRequestSchema },
      },
    },
  },
  responses: {
    202: {
      content: {
        "application/json": { schema: eventResponseSchema },
      },
      description: "Event accepted and dispatched",
    },
    400: {
      content: { "application/json": { schema: errorSchema } },
      description: "Missing recipient or unmanageable list membership",
    },
    403: {
      content: { "application/json": { schema: errorSchema } },
      description:
        "Publishable key attempted to act on another identity without a verified userToken",
    },
  },
});

export const eventsRouter = new OpenAPIHono<AppEnv>().openapi(
  eventRoute,
  async (c) => {
    const { db, registry, hatchet, logger, analytics, env } =
      c.get("container");
    const body = c.req.valid("json");

    const guard = gatePublishableIdentity(c, body, env.BETTER_AUTH_SECRET);
    if (guard) return guard;

    // The `Idempotency-Key` header wins over the body field (§2.5).
    const headerKey = c.req.header("idempotency-key");
    const idempotencyKey = headerKey ?? body.idempotencyKey;

    let result: Awaited<ReturnType<typeof ingestEvent>>;
    try {
      result = await ingestEvent({
        db,
        registry,
        hatchet,
        logger,
        // §5.3: thread the active analytics provider so a collide-MERGE /
        // key-flip fires the provider-neutral `mergeIdentities` stitch.
        analytics,
        // §Phase 1 GAP-1: a publishable (pk_) browser write is anon-clamped —
        // its browser-readable `anonymousId` may NOT attach to / merge / poison
        // an already-identified victim contact. Secret-key ingest is never
        // clamped.
        restrictToAnonymous: c.get("publishable") === true,
        event: {
          event: body.name,
          userId: body.userId,
          userEmail: body.email,
          // §4: 2nd-precedence resolver key — lets the contact's canonical key
          // equal the browser anon id (zero-merge stitch).
          anonymousId: body.anonymousId,
          eventProperties: body.eventProperties ?? {},
          contactProperties: body.contactProperties,
          value: body.value,
          currency: body.currency,
          idempotencyKey,
          // §2.5: caller-supplied event time (backfill/replay). The validated
          // ISO string is coerced to a Date inside ingestEvent.
          occurredAt: body.timestamp,
          // Provenance derived from the authenticated key CLASS, never the
          // request body (so it can't be spoofed): a publishable (pk_) key is
          // always an in-app surface interaction from @hogsend/js; a secret key
          // is the server-side data plane. "inapp" still fans out to PostHog
          // (the loop-guard only special-cases "posthog").
          source: c.get("publishable") === true ? "inapp" : "api",
        },
      });
    } catch (err) {
      // A publishable anon write that resolved to an identified victim contact
      // (or would drive a merge) is rejected at the resolver — surface as 403.
      if (err instanceof PublishableAnonymousMergeError) {
        return c.json({ error: err.message }, 403);
      }
      throw err;
    }

    // Lists applied AFTER ingest so the contact exists (§2.5 lists ordering).
    // `applyListMembership` writes `email_preferences` independently of the
    // contacts row, so it doesn't race the resolve. Requires a resolvable email.
    //
    // The ingest above is already durable (event stored, journeys dispatched,
    // exits processed). A list-write failure here must NOT be reported as a 400
    // — that would (a) hide a successful ingest behind a "nothing happened"
    // status and (b) tempt a client to retry, re-ingesting the event. Surface it
    // as a `listsError` warning on the 202 instead.
    let listsError: string | undefined;
    // §Phase 1 GAP-2 (defense in depth): a publishable caller reaching here has
    // no token-less email/userId (the gate 403'd it) — but assert it explicitly
    // so a future change that lets `anonymousId` carry a list write can't
    // silently write `email_preferences` for a victim. `applyListMembership`
    // needs a resolvable email anyway; a publishable list write is a no-op.
    const publishableListWrite =
      c.get("publishable") === true && (body.email || body.userId);
    if (
      !publishableListWrite &&
      body.lists &&
      Object.keys(body.lists).length > 0
    ) {
      try {
        await applyListMembership({
          db,
          userId: body.userId,
          email: body.email,
          lists: body.lists,
        });
      } catch (err) {
        listsError = listMembershipError(err);
      }
    }

    return c.json({ ...result, ...(listsError ? { listsError } : {}) }, 202);
  },
);
