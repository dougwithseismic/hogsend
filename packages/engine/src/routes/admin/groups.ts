import { contacts, groupMemberships, groups, userEvents } from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { AppEnv } from "../../app.js";

/**
 * Read-only admin surface over the sovereign group model — the endpoints the
 * Studio OBSERVE view consumes. Groups are pure DB rows (`groups` /
 * `group_memberships`), so unlike buckets there is no registry: every query hits
 * the tables directly. All dates serialize to ISO strings; the router inherits
 * the admin router's `requireAdmin` guard, so it never re-auths here.
 */

const groupSchema = z.object({
  id: z.string(),
  groupType: z.string(),
  groupKey: z.string(),
  displayName: z.string().nullable(),
  properties: z.record(z.string(), z.unknown()),
  memberCount: z.number(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
});

const memberSchema = z.object({
  contactId: z.string(),
  email: z.string().nullable(),
  externalId: z.string().nullable(),
  role: z.string().nullable(),
  joinedAt: z.string(),
});

const eventSchema = z.object({
  id: z.string(),
  event: z.string(),
  occurredAt: z.string(),
  userId: z.string(),
});

const errorSchema = z.object({ error: z.string() });

function serializeGroup(row: typeof groups.$inferSelect, memberCount: number) {
  return {
    id: row.id,
    groupType: row.groupType,
    groupKey: row.groupKey,
    displayName: row.displayName,
    properties: (row.properties ?? {}) as Record<string, unknown>,
    memberCount,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
  };
}

function serializeMember(row: {
  contactId: string;
  email: string | null;
  externalId: string | null;
  role: string | null;
  joinedAt: Date;
}) {
  return {
    contactId: row.contactId,
    email: row.email,
    externalId: row.externalId,
    role: row.role,
    joinedAt: row.joinedAt.toISOString(),
  };
}

function serializeEvent(row: {
  id: string;
  event: string;
  occurredAt: Date;
  userId: string;
}) {
  return {
    id: row.id,
    event: row.event,
    occurredAt: row.occurredAt.toISOString(),
    userId: row.userId,
  };
}

// --- Route definitions ---

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin — Groups"],
  summary: "List groups",
  request: {
    query: z.object({
      limit: z.coerce.number().min(1).max(100).default(50),
      offset: z.coerce.number().min(0).default(0),
      groupType: z.string().optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            groups: z.array(groupSchema),
            total: z.number(),
            limit: z.number(),
            offset: z.number(),
          }),
        },
      },
      description: "Paginated group list, newest-seen first",
    },
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/{groupType}/{groupKey}",
  tags: ["Admin — Groups"],
  summary: "Get group detail",
  request: {
    params: z.object({ groupType: z.string(), groupKey: z.string() }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            group: groupSchema.extend({
              recentMembers: z.array(memberSchema),
              recentEvents: z.array(eventSchema),
            }),
          }),
        },
      },
      description: "Group detail with recent members and recent tagged events",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Group not found",
    },
  },
});

const listMembersRoute = createRoute({
  method: "get",
  path: "/{groupType}/{groupKey}/members",
  tags: ["Admin — Groups"],
  summary: "List group members",
  request: {
    params: z.object({ groupType: z.string(), groupKey: z.string() }),
    query: z.object({
      limit: z.coerce.number().min(1).max(100).default(50),
      offset: z.coerce.number().min(0).default(0),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            members: z.array(memberSchema),
            total: z.number(),
            limit: z.number(),
            offset: z.number(),
          }),
        },
      },
      description: "Paginated group members, newest-joined first",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Group not found",
    },
  },
});

// --- Handlers ---

export const groupsRouter = new OpenAPIHono<AppEnv>()
  .openapi(listRoute, async (c) => {
    const { db } = c.get("container");
    const { limit, offset, groupType } = c.req.valid("query");

    const where = and(
      isNull(groups.deletedAt),
      ...(groupType ? [eq(groups.groupType, groupType)] : []),
    );

    const [rows, totalRows] = await Promise.all([
      db
        .select()
        .from(groups)
        .where(where)
        .orderBy(desc(groups.lastSeenAt))
        .limit(limit)
        .offset(offset),
      db.select({ count: count() }).from(groups).where(where),
    ]);

    // One grouped count over the page's group ids — mirrors how buckets maps
    // its per-bucket status counts back onto the listed rows.
    const groupIds = rows.map((r) => r.id);
    const memberCounts =
      groupIds.length > 0
        ? await db
            .select({
              groupId: groupMemberships.groupId,
              count: count(),
            })
            .from(groupMemberships)
            .where(inArray(groupMemberships.groupId, groupIds))
            .groupBy(groupMemberships.groupId)
        : [];
    const countMap = new Map(memberCounts.map((r) => [r.groupId, r.count]));

    return c.json(
      {
        groups: rows.map((r) => serializeGroup(r, countMap.get(r.id) ?? 0)),
        total: totalRows[0]?.count ?? 0,
        limit,
        offset,
      },
      200,
    );
  })
  .openapi(listMembersRoute, async (c) => {
    const { db } = c.get("container");
    const { groupType, groupKey } = c.req.valid("param");
    const { limit, offset } = c.req.valid("query");

    const groupRows = await db
      .select({ id: groups.id })
      .from(groups)
      .where(
        and(
          eq(groups.groupType, groupType),
          eq(groups.groupKey, groupKey),
          isNull(groups.deletedAt),
        ),
      )
      .limit(1);
    const group = groupRows[0];
    if (!group) {
      return c.json({ error: "Group not found" }, 404);
    }

    // Join to LIVE contacts so a soft-deleted contact never surfaces; the total
    // counts the same joined set the page is drawn from.
    const memberWhere = and(
      eq(groupMemberships.groupId, group.id),
      isNull(contacts.deletedAt),
    );

    const [rows, totalRows] = await Promise.all([
      db
        .select({
          contactId: groupMemberships.contactId,
          email: contacts.email,
          externalId: contacts.externalId,
          role: groupMemberships.role,
          joinedAt: groupMemberships.joinedAt,
        })
        .from(groupMemberships)
        .innerJoin(contacts, eq(groupMemberships.contactId, contacts.id))
        .where(memberWhere)
        .orderBy(desc(groupMemberships.joinedAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: count() })
        .from(groupMemberships)
        .innerJoin(contacts, eq(groupMemberships.contactId, contacts.id))
        .where(memberWhere),
    ]);

    return c.json(
      {
        members: rows.map(serializeMember),
        total: totalRows[0]?.count ?? 0,
        limit,
        offset,
      },
      200,
    );
  })
  .openapi(getRoute, async (c) => {
    const { db } = c.get("container");
    const { groupType, groupKey } = c.req.valid("param");

    const groupRows = await db
      .select()
      .from(groups)
      .where(
        and(
          eq(groups.groupType, groupType),
          eq(groups.groupKey, groupKey),
          isNull(groups.deletedAt),
        ),
      )
      .limit(1);
    const group = groupRows[0];
    if (!group) {
      return c.json({ error: "Group not found" }, 404);
    }

    const [memberCountRows, recentMemberRows, recentEventRows] =
      await Promise.all([
        db
          .select({ count: count() })
          .from(groupMemberships)
          .where(eq(groupMemberships.groupId, group.id)),
        db
          .select({
            contactId: groupMemberships.contactId,
            email: contacts.email,
            externalId: contacts.externalId,
            role: groupMemberships.role,
            joinedAt: groupMemberships.joinedAt,
          })
          .from(groupMemberships)
          .innerJoin(contacts, eq(groupMemberships.contactId, contacts.id))
          .where(
            and(
              eq(groupMemberships.groupId, group.id),
              isNull(contacts.deletedAt),
            ),
          )
          .orderBy(desc(groupMemberships.joinedAt))
          .limit(10),
        // Events carry a `groups` association map (groupType → groupKey); the
        // jsonb containment operator selects those tagged with this group.
        db
          .select({
            id: userEvents.id,
            event: userEvents.event,
            occurredAt: userEvents.occurredAt,
            userId: userEvents.userId,
          })
          .from(userEvents)
          .where(
            sql`${userEvents.groups} @> ${JSON.stringify({
              [groupType]: groupKey,
            })}::jsonb`,
          )
          .orderBy(desc(userEvents.occurredAt))
          .limit(20),
      ]);

    const memberCount = memberCountRows[0]?.count ?? 0;

    return c.json(
      {
        group: {
          ...serializeGroup(group, memberCount),
          recentMembers: recentMemberRows.map(serializeMember),
          recentEvents: recentEventRows.map(serializeEvent),
        },
      },
      200,
    );
  });
