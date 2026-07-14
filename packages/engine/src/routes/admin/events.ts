import { contacts, userEvents } from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, count, desc, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import type { AppEnv } from "../../app.js";
import type { HogsendClient } from "../../container.js";
import {
  eventNameEntrySchema,
  listEventNameVocabulary,
} from "../../lib/event-names.js";
import { ingestEvent } from "../../lib/ingestion.js";

const eventSchema = z.object({
  id: z.string(),
  userId: z.string(),
  event: z.string(),
  properties: z.record(z.string(), z.unknown()).nullable(),
  occurredAt: z.string(),
  // Where the event entered the pipeline ("posthog", "api", "studio", …).
  source: z.string().nullable(),
  // Resolved from THE live contact whose key (externalId, anonymousId, or
  // id) matches user_events.userId — shows WHO an event is from.
  userEmail: z.string().nullable(),
  contactId: z.string().nullable(),
});

const errorSchema = z.object({ error: z.string() });

/** A `userEvents` row joined to its (optional) live contact. */
type JoinedEvent = {
  event: typeof userEvents.$inferSelect;
  contact: { id: string; email: string | null } | null;
};

function serializeEvent(row: JoinedEvent) {
  const e = row.event;
  return {
    id: e.id,
    userId: e.userId,
    event: e.event,
    properties: (e.properties ?? null) as Record<string, unknown> | null,
    occurredAt: e.occurredAt.toISOString(),
    source: e.source ?? null,
    userEmail: row.contact?.email ?? null,
    contactId: row.contact?.id ?? null,
  };
}

/**
 * LATERAL pick of THE live contact for an event's userId. `userEvents.userId`
 * holds the resolved canonical key (`external_id ?? anonymous_id ?? id`), so
 * match all three — covering email-only/anonymous contacts, not just
 * externalId-keyed ones. Each column is partial-unique among live rows, but
 * the three namespaces are NOT guaranteed disjoint across contacts: a
 * mis-keyed emitter can park one contact's key in another contact's
 * anonymous_id, and a bare OR-join then matches BOTH — fanning every event
 * out into one display row per matching contact. The lateral picks exactly
 * one, by the same precedence ingest resolves keys with.
 */
function liveContactFor(db: HogsendClient["db"]) {
  return db
    .select({ id: contacts.id, email: contacts.email })
    .from(contacts)
    .where(
      and(
        or(
          eq(contacts.externalId, userEvents.userId),
          eq(contacts.anonymousId, userEvents.userId),
          eq(sql`${contacts.id}::text`, userEvents.userId),
        ),
        isNull(contacts.deletedAt),
      ),
    )
    .orderBy(
      sql`case when ${contacts.externalId} = ${userEvents.userId} then 0 when ${contacts.anonymousId} = ${userEvents.userId} then 1 else 2 end`,
    )
    .limit(1)
    .as("live_contact");
}

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin — Events"],
  summary: "List events",
  request: {
    query: z.object({
      limit: z.coerce.number().min(1).max(100).default(50),
      offset: z.coerce.number().min(0).default(0),
      userId: z.string().optional(),
      event: z.string().optional(),
      source: z.string().optional(),
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            events: z.array(eventSchema),
            total: z.number(),
            limit: z.number(),
            offset: z.number(),
          }),
        },
      },
      description: "Paginated event list",
    },
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Admin — Events"],
  summary: "Get event detail",
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ event: eventSchema }),
        },
      },
      description: "Event detail",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Event not found",
    },
  },
});

const namesRoute = createRoute({
  method: "get",
  path: "/names",
  tags: ["Admin — Events"],
  summary: "List event names (observed + declared)",
  description:
    "Best-effort event-name vocabulary for authoring triggers, waits, and " +
    "exitOn rules. Event names are an OPEN vocabulary (no closed registry " +
    "exists anywhere in the engine), so this merges: events actually " +
    "observed in the event store (with occurrence counts, most recently " +
    "seen first) and events referenced as code-journey or blueprint " +
    "triggers. Any other event name is also valid — it just hasn't been " +
    "seen yet.",
  request: {
    query: z.object({
      // Case-insensitive substring filter on the event name.
      search: z.string().min(1).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(100),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            note: z.string(),
            events: z.array(eventNameEntrySchema),
          }),
        },
      },
      description: "Merged observed + declared event-name vocabulary",
    },
  },
});

const exitSchema = z.object({
  journeyId: z.string(),
  stateId: z.string(),
  exited: z.boolean(),
});

const ingestRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Admin — Events"],
  summary: "Ingest a test event",
  description:
    "Session-authed ingest for the Studio Debug panel. Runs an event " +
    "through the full ingest pipeline (stores it, routes it to journeys, " +
    "evaluates exits). Inherits requireAdmin session auth from the admin " +
    "mount — does NOT accept an hsk_ API key.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            event: z.string().min(1),
            userId: z.string().optional(),
            userEmail: z.string().optional(),
            properties: z.record(z.string(), z.unknown()).optional(),
          }),
        },
      },
    },
  },
  responses: {
    202: {
      content: {
        "application/json": {
          schema: z.object({
            stored: z.boolean(),
            exits: z.array(exitSchema),
          }),
        },
      },
      description: "Event accepted and ingested",
    },
  },
});

export const eventsRouter = new OpenAPIHono<AppEnv>()
  .openapi(ingestRoute, async (c) => {
    const { db, registry, hatchet, logger } = c.get("container");
    const { event, userId, userEmail, properties } = c.req.valid("json");

    const result = await ingestEvent({
      db,
      registry,
      hatchet,
      logger,
      event: {
        event,
        userId,
        userEmail,
        eventProperties: properties ?? {},
        // The Studio Debug panel ("Fire event").
        source: "studio",
      },
    });

    return c.json(result, 202);
  })
  .openapi(listRoute, async (c) => {
    const { db } = c.get("container");
    const { limit, offset, userId, event, source, from, to } =
      c.req.valid("query");

    const conditions = [];
    if (userId) conditions.push(eq(userEvents.userId, userId));
    if (event) conditions.push(eq(userEvents.event, event));
    if (source) conditions.push(eq(userEvents.source, source));
    if (from) conditions.push(gte(userEvents.occurredAt, new Date(from)));
    if (to) conditions.push(lte(userEvents.occurredAt, new Date(to)));

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const liveContact = liveContactFor(db);
    const [rows, totalRows] = await Promise.all([
      db
        .select({
          event: userEvents,
          contact: { id: liveContact.id, email: liveContact.email },
        })
        .from(userEvents)
        .leftJoinLateral(liveContact, sql`true`)
        .where(where)
        .orderBy(desc(userEvents.occurredAt))
        .limit(limit)
        .offset(offset),
      db.select({ count: count() }).from(userEvents).where(where),
    ]);

    return c.json(
      {
        events: rows.map(serializeEvent),
        total: totalRows[0]?.count ?? 0,
        limit,
        offset,
      },
      200,
    );
  })
  // Registered before getRoute so the literal "names" is never captured as
  // an {id}. Delegates to the shared vocabulary helper (lib/event-names.ts)
  // — the same implementation the blueprint tools' `list_events` serves, so
  // the HTTP surface and the in-process tool can never drift.
  .openapi(namesRoute, async (c) => {
    const { db, registry } = c.get("container");
    const { search, limit } = c.req.valid("query");

    const { note, events } = await listEventNameVocabulary({
      db,
      registry,
      search,
      limit,
    });
    return c.json({ note, events }, 200);
  })
  .openapi(getRoute, async (c) => {
    const { db } = c.get("container");
    const { id } = c.req.valid("param");

    const liveContact = liveContactFor(db);
    const rows = await db
      .select({
        event: userEvents,
        contact: { id: liveContact.id, email: liveContact.email },
      })
      .from(userEvents)
      .leftJoinLateral(liveContact, sql`true`)
      .where(eq(userEvents.id, id))
      .limit(1);

    const row = rows[0];
    if (!row) {
      return c.json({ error: "Event not found" }, 404);
    }

    return c.json({ event: serializeEvent(row) }, 200);
  });
