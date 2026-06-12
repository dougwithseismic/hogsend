import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import { ingestEvent } from "../../lib/ingestion.js";
import { applyListMembership } from "../../lib/preferences.js";
import { errorSchema } from "../../lib/schemas.js";
import { listMembershipError, requireIdentity } from "../_shared.js";

const eventRequestSchema = z.object({
  name: z.string().min(1),
  email: z.string().email().optional(),
  userId: z.string().min(1).optional(),
  eventProperties: z.record(z.string(), z.unknown()).optional(),
  contactProperties: z.record(z.string(), z.unknown()).optional(),
  lists: z.record(z.string(), z.boolean()).optional(),
  idempotencyKey: z.string().optional(),
  timestamp: z.string().datetime().optional(),
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
  },
});

export const eventsRouter = new OpenAPIHono<AppEnv>().openapi(
  eventRoute,
  async (c) => {
    const { db, registry, hatchet, logger } = c.get("container");
    const body = c.req.valid("json");

    const guard = requireIdentity(c, body);
    if (guard) return guard;

    // The `Idempotency-Key` header wins over the body field (§2.5).
    const headerKey = c.req.header("idempotency-key");
    const idempotencyKey = headerKey ?? body.idempotencyKey;

    const result = await ingestEvent({
      db,
      registry,
      hatchet,
      logger,
      event: {
        event: body.name,
        userId: body.userId,
        userEmail: body.email,
        eventProperties: body.eventProperties ?? {},
        contactProperties: body.contactProperties,
        idempotencyKey,
        // §2.5: caller-supplied event time (backfill/replay). The validated ISO
        // string is coerced to a Date inside ingestEvent.
        occurredAt: body.timestamp,
      },
    });

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
    if (body.lists && Object.keys(body.lists).length > 0) {
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
