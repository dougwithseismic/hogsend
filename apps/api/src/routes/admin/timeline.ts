import { emailSends, journeyStates, userEvents } from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { count, desc, eq } from "drizzle-orm";
import type { AppEnv } from "../../app.js";
import { resolveContact } from "../../lib/contacts.js";

const timelineEntrySchema = z.object({
  type: z.enum(["event", "journey", "email"]),
  timestamp: z.string(),
  data: z.record(z.string(), z.unknown()),
});

const errorSchema = z.object({ error: z.string() });

const listRoute = createRoute({
  method: "get",
  path: "/{id}/timeline",
  tags: ["Admin — Timeline"],
  summary: "Get contact activity timeline",
  request: {
    params: z.object({ id: z.string() }),
    query: z.object({
      limit: z.coerce.number().min(1).max(100).default(50),
      offset: z.coerce.number().min(0).default(0),
      type: z.enum(["event", "journey", "email"]).optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            timeline: z.array(timelineEntrySchema),
            total: z.number(),
            limit: z.number(),
            offset: z.number(),
          }),
        },
      },
      description: "Chronological activity timeline",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Contact not found",
    },
  },
});

type TimelineEntry = {
  type: "event" | "journey" | "email";
  timestamp: string;
  data: Record<string, unknown>;
};

export const timelineRouter = new OpenAPIHono<AppEnv>().openapi(
  listRoute,
  async (c) => {
    const { db } = c.get("container");
    const { id } = c.req.valid("param");
    const { limit, offset, type } = c.req.valid("query");

    const contact = await resolveContact({ db, id });
    if (!contact) {
      return c.json({ error: "Contact not found" }, 404);
    }

    const externalId = contact.externalId;
    const entries: TimelineEntry[] = [];

    const shouldFetch = (t: string) => !type || type === t;
    const fetchLimit = limit + offset;

    const [
      eventRows,
      journeyRows,
      emailRows,
      eventCount,
      journeyCount,
      emailCount,
    ] = await Promise.all([
      shouldFetch("event")
        ? db
            .select()
            .from(userEvents)
            .where(eq(userEvents.userId, externalId))
            .orderBy(desc(userEvents.occurredAt))
            .limit(fetchLimit)
        : Promise.resolve([]),
      shouldFetch("journey")
        ? db
            .select()
            .from(journeyStates)
            .where(eq(journeyStates.userId, externalId))
            .orderBy(desc(journeyStates.createdAt))
            .limit(fetchLimit)
        : Promise.resolve([]),
      shouldFetch("email")
        ? db
            .select({
              id: emailSends.id,
              templateKey: emailSends.templateKey,
              subject: emailSends.subject,
              status: emailSends.status,
              toEmail: emailSends.toEmail,
              fromEmail: emailSends.fromEmail,
              sentAt: emailSends.sentAt,
              deliveredAt: emailSends.deliveredAt,
              openedAt: emailSends.openedAt,
              createdAt: emailSends.createdAt,
            })
            .from(emailSends)
            .innerJoin(
              journeyStates,
              eq(emailSends.journeyStateId, journeyStates.id),
            )
            .where(eq(journeyStates.userId, externalId))
            .orderBy(desc(emailSends.createdAt))
            .limit(fetchLimit)
        : Promise.resolve([]),
      shouldFetch("event")
        ? db
            .select({ count: count() })
            .from(userEvents)
            .where(eq(userEvents.userId, externalId))
            .then((r) => r[0]?.count ?? 0)
        : Promise.resolve(0),
      shouldFetch("journey")
        ? db
            .select({ count: count() })
            .from(journeyStates)
            .where(eq(journeyStates.userId, externalId))
            .then((r) => r[0]?.count ?? 0)
        : Promise.resolve(0),
      shouldFetch("email")
        ? db
            .select({ count: count() })
            .from(emailSends)
            .innerJoin(
              journeyStates,
              eq(emailSends.journeyStateId, journeyStates.id),
            )
            .where(eq(journeyStates.userId, externalId))
            .then((r) => r[0]?.count ?? 0)
        : Promise.resolve(0),
    ]);

    for (const row of eventRows) {
      entries.push({
        type: "event",
        timestamp: row.occurredAt.toISOString(),
        data: {
          id: row.id,
          event: row.event,
          properties: row.properties ?? {},
        },
      });
    }

    for (const row of journeyRows) {
      entries.push({
        type: "journey",
        timestamp: row.createdAt.toISOString(),
        data: {
          id: row.id,
          journeyId: row.journeyId,
          status: row.status,
          currentNodeId: row.currentNodeId,
          completedAt: row.completedAt?.toISOString() ?? null,
          exitedAt: row.exitedAt?.toISOString() ?? null,
        },
      });
    }

    for (const row of emailRows) {
      entries.push({
        type: "email",
        timestamp: row.createdAt.toISOString(),
        data: {
          id: row.id,
          templateKey: row.templateKey,
          subject: row.subject,
          status: row.status,
          toEmail: row.toEmail,
          sentAt: row.sentAt?.toISOString() ?? null,
          deliveredAt: row.deliveredAt?.toISOString() ?? null,
          openedAt: row.openedAt?.toISOString() ?? null,
        },
      });
    }

    entries.sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );

    const total = eventCount + journeyCount + emailCount;
    const paged = entries.slice(offset, offset + limit);

    return c.json({ timeline: paged, total, limit, offset }, 200);
  },
);
