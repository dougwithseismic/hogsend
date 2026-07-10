import {
  type Database,
  emailSends,
  journeyStates,
  linkClicks,
  trackedLinks,
} from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  gte,
  inArray,
  isNotNull,
  isNull,
  like,
  lte,
  or,
} from "drizzle-orm";
import type { AppEnv } from "../../app.js";
import { campaignSendKeyPattern } from "../../lib/campaign-send-key.js";

const emailSchema = z.object({
  id: z.string(),
  journeyStateId: z.string().nullable(),
  templateKey: z.string().nullable(),
  messageId: z.string().nullable(),
  /** @deprecated Mirrors `messageId`; kept for one minor, removed thereafter. */
  resendId: z.string().nullable(),
  fromEmail: z.string(),
  toEmail: z.string(),
  subject: z.string(),
  category: z.string().nullable(),
  status: z.string(),
  userId: z.string().nullable(),
  journeyId: z.string().nullable(),
  sentAt: z.string().nullable(),
  deliveredAt: z.string().nullable(),
  openedAt: z.string().nullable(),
  clickedAt: z.string().nullable(),
  bouncedAt: z.string().nullable(),
  complainedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const eventSchema = z.object({
  type: z.string(),
  timestamp: z.string(),
  url: z.string().optional(),
  ipAddress: z.string().nullable().optional(),
  userAgent: z.string().nullable().optional(),
});

const trackedLinkSchema = z.object({
  id: z.string(),
  originalUrl: z.string(),
  clickCount: z.number(),
  clicks: z.array(
    z.object({
      id: z.string(),
      clickedAt: z.string(),
      ipAddress: z.string().nullable(),
      userAgent: z.string().nullable(),
    }),
  ),
});

const journeyContextSchema = z
  .object({
    journeyId: z.string(),
    userId: z.string(),
    status: z.string(),
    currentNodeId: z.string(),
  })
  .nullable();

import { errorSchema } from "../../lib/schemas.js";

function serializeEmail(
  row: typeof emailSends.$inferSelect,
  identity: { userId: string | null; journeyId: string | null } = {
    userId: null,
    journeyId: null,
  },
) {
  return {
    id: row.id,
    journeyStateId: row.journeyStateId,
    templateKey: row.templateKey,
    messageId: row.messageId,
    // @deprecated Mirror of `messageId` for one minor (back-compat).
    resendId: row.messageId,
    fromEmail: row.fromEmail,
    toEmail: row.toEmail,
    subject: row.subject,
    category: row.category,
    status: row.status,
    userId: identity.userId,
    journeyId: identity.journeyId,
    sentAt: row.sentAt?.toISOString() ?? null,
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
    openedAt: row.openedAt?.toISOString() ?? null,
    clickedAt: row.clickedAt?.toISOString() ?? null,
    bouncedAt: row.bouncedAt?.toISOString() ?? null,
    complainedAt: row.complainedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin — Emails"],
  summary: "List email sends",
  request: {
    query: z.object({
      limit: z.coerce.number().min(1).max(100).default(50),
      offset: z.coerce.number().min(0).default(0),
      toEmail: z.string().optional(),
      templateKey: z.string().optional(),
      status: z
        .enum([
          "queued",
          "rendered",
          "sent",
          "delivered",
          "opened",
          "clicked",
          "bounced",
          "complained",
          "failed",
        ])
        .optional(),
      journeyId: z.string().optional(),
      /**
       * Only the sends of one campaign — matched on the deterministic
       * `campaign:<id>:<email>` idempotency key the blast wrote per recipient.
       */
      campaignId: z.string().optional(),
      userId: z.string().optional(),
      category: z.string().optional(),
      engagement: z
        .enum(["opened", "clicked", "bounced", "complained"])
        .optional(),
      sort: z
        .enum(["createdAt", "sentAt", "openedAt", "clickedAt"])
        .default("createdAt"),
      order: z.enum(["asc", "desc"]).default("desc"),
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            emails: z.array(emailSchema),
            total: z.number(),
            limit: z.number(),
            offset: z.number(),
          }),
        },
      },
      description: "Paginated email send list",
    },
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Admin — Emails"],
  summary: "Get email detail with delivery timeline and link clicks",
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            email: emailSchema,
            events: z.array(eventSchema),
            trackedLinks: z.array(trackedLinkSchema),
            journeyContext: journeyContextSchema,
          }),
        },
      },
      description: "Email detail with tracked links and journey context",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Email not found",
    },
  },
});

async function fetchTrackedLinksWithClicks(db: Database, emailSendId: string) {
  const links = await db
    .select()
    .from(trackedLinks)
    .where(eq(trackedLinks.emailSendId, emailSendId))
    .orderBy(trackedLinks.createdAt);

  if (links.length === 0) return [];

  const linkIds = links.map((l) => l.id);
  const clicks = await db
    .select()
    .from(linkClicks)
    .where(inArray(linkClicks.trackedLinkId, linkIds))
    .orderBy(linkClicks.clickedAt);

  const clicksByLink = new Map<string, (typeof clicks)[number][]>();
  for (const click of clicks) {
    const arr = clicksByLink.get(click.trackedLinkId) ?? [];
    arr.push(click);
    clicksByLink.set(click.trackedLinkId, arr);
  }

  return links.map((link) => ({
    id: link.id,
    originalUrl: link.originalUrl,
    clickCount: link.clickCount,
    clicks: (clicksByLink.get(link.id) ?? []).map((click) => ({
      id: click.id,
      clickedAt: click.clickedAt.toISOString(),
      ipAddress: click.ipAddress,
      userAgent: click.userAgent,
    })),
  }));
}

export const emailsRouter = new OpenAPIHono<AppEnv>()
  .openapi(listRoute, async (c) => {
    const { db } = c.get("container");
    const {
      limit,
      offset,
      toEmail,
      templateKey,
      status,
      journeyId,
      campaignId,
      userId,
      category,
      engagement,
      sort,
      order,
      from,
      to,
    } = c.req.valid("query");

    const engagementColumn = {
      opened: emailSends.openedAt,
      clicked: emailSends.clickedAt,
      bounced: emailSends.bouncedAt,
      complained: emailSends.complainedAt,
    } as const;

    const sortColumn = {
      createdAt: emailSends.createdAt,
      sentAt: emailSends.sentAt,
      openedAt: emailSends.openedAt,
      clickedAt: emailSends.clickedAt,
    } as const;

    const conditions = [];
    if (toEmail) conditions.push(eq(emailSends.toEmail, toEmail));
    if (templateKey) conditions.push(eq(emailSends.templateKey, templateKey));
    if (status) conditions.push(eq(emailSends.status, status));
    if (category) conditions.push(eq(emailSends.category, category));
    if (journeyId) conditions.push(eq(journeyStates.journeyId, journeyId));
    if (campaignId) {
      conditions.push(
        like(emailSends.idempotencyKey, campaignSendKeyPattern(campaignId)),
      );
    }
    // Match the denormalized identity OR the journey-state join, so journeyless
    // sends (which only carry the denormalized userId) are still filterable.
    if (userId) {
      conditions.push(
        or(eq(emailSends.userId, userId), eq(journeyStates.userId, userId)),
      );
    }
    if (engagement) conditions.push(isNotNull(engagementColumn[engagement]));
    if (from) conditions.push(gte(emailSends.createdAt, new Date(from)));
    if (to) conditions.push(lte(emailSends.createdAt, new Date(to)));

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const orderBy =
      order === "asc" ? asc(sortColumn[sort]) : desc(sortColumn[sort]);

    const joinCondition = and(
      eq(emailSends.journeyStateId, journeyStates.id),
      isNull(journeyStates.deletedAt),
    );

    const [rows, totalRows] = await Promise.all([
      db
        .select({
          ...getTableColumns(emailSends),
          identityUserId: journeyStates.userId,
          identityJourneyId: journeyStates.journeyId,
        })
        .from(emailSends)
        .leftJoin(journeyStates, joinCondition)
        .where(where)
        .orderBy(orderBy)
        .limit(limit)
        .offset(offset),
      db
        .select({ count: count() })
        .from(emailSends)
        .leftJoin(journeyStates, joinCondition)
        .where(where),
    ]);

    return c.json(
      {
        emails: rows.map(({ identityUserId, identityJourneyId, ...row }) =>
          // Prefer the denormalized identity on the send row; fall back to the
          // journey-state join (covers rows written before denormalization).
          serializeEmail(row, {
            userId: row.userId ?? identityUserId,
            journeyId: identityJourneyId,
          }),
        ),
        total: totalRows[0]?.count ?? 0,
        limit,
        offset,
      },
      200,
    );
  })
  .openapi(getRoute, async (c) => {
    const { db } = c.get("container");
    const { id } = c.req.valid("param");

    const rows = await db
      .select()
      .from(emailSends)
      .where(eq(emailSends.id, id))
      .limit(1);

    const row = rows[0];
    if (!row) {
      return c.json({ error: "Email not found" }, 404);
    }

    const [links, journeyContext] = await Promise.all([
      fetchTrackedLinksWithClicks(db, id),
      row.journeyStateId
        ? db
            .select({
              journeyId: journeyStates.journeyId,
              userId: journeyStates.userId,
              status: journeyStates.status,
              currentNodeId: journeyStates.currentNodeId,
            })
            .from(journeyStates)
            .where(
              and(
                eq(journeyStates.id, row.journeyStateId),
                isNull(journeyStates.deletedAt),
              ),
            )
            .limit(1)
            .then((rows) => rows[0] ?? null)
        : Promise.resolve(null),
    ]);

    const events: z.infer<typeof eventSchema>[] = [];
    if (row.createdAt)
      events.push({ type: "queued", timestamp: row.createdAt.toISOString() });
    if (row.sentAt)
      events.push({ type: "sent", timestamp: row.sentAt.toISOString() });
    if (row.deliveredAt)
      events.push({
        type: "delivered",
        timestamp: row.deliveredAt.toISOString(),
      });
    if (row.openedAt)
      events.push({ type: "opened", timestamp: row.openedAt.toISOString() });
    if (row.bouncedAt)
      events.push({ type: "bounced", timestamp: row.bouncedAt.toISOString() });
    if (row.complainedAt)
      events.push({
        type: "complained",
        timestamp: row.complainedAt.toISOString(),
      });
    if (row.status === "failed" && row.updatedAt)
      events.push({ type: "failed", timestamp: row.updatedAt.toISOString() });

    for (const link of links) {
      for (const click of link.clicks) {
        events.push({
          type: "clicked",
          timestamp: click.clickedAt,
          url: link.originalUrl,
          ipAddress: click.ipAddress,
          userAgent: click.userAgent,
        });
      }
    }

    events.sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );

    return c.json(
      {
        email: serializeEmail(row, {
          userId: row.userId ?? journeyContext?.userId ?? null,
          journeyId: journeyContext?.journeyId ?? null,
        }),
        events,
        trackedLinks: links,
        journeyContext,
      },
      200,
    );
  });
