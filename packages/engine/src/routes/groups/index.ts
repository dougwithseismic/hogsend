import type { Group } from "@hogsend/core";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import {
  addGroupMember,
  GroupContactNotFoundError,
  getGroup,
  identifyGroup,
  listGroupMembers,
  listGroups,
  removeGroupMember,
} from "../../lib/groups.js";
import { emitOutbound } from "../../lib/outbound.js";
import { errorSchema } from "../../lib/schemas.js";

// The public, serialized group shape. Internal columns (`organizationId`,
// `deletedAt`) are omitted; timestamps are ISO strings. Mirrors contacts'
// `serializeContact`/`contactSchema` pattern.
const groupSchema = z.object({
  id: z.string(),
  groupType: z.string(),
  groupKey: z.string(),
  displayName: z.string().nullable(),
  properties: z.record(z.string(), z.unknown()).nullable(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

function serializeGroup(group: Group): z.infer<typeof groupSchema> {
  return {
    id: group.id,
    groupType: group.groupType,
    groupKey: group.groupKey,
    displayName: group.displayName,
    properties: group.properties,
    firstSeenAt: group.firstSeenAt.toISOString(),
    lastSeenAt: group.lastSeenAt.toISOString(),
    createdAt: group.createdAt.toISOString(),
    updatedAt: group.updatedAt.toISOString(),
  };
}

// The serialized membership shape returned by the add-member route. Internal
// columns (`organizationId`, `createdAt`, `updatedAt`) are omitted; `joinedAt`
// is an ISO string.
const membershipSchema = z.object({
  id: z.string(),
  groupId: z.string(),
  contactId: z.string(),
  role: z.string().nullable(),
  joinedAt: z.string(),
});

// A member row: the contact behind a membership, joined to its identity.
const memberSchema = z.object({
  contactId: z.string(),
  email: z.string().nullable(),
  externalId: z.string().nullable(),
  role: z.string().nullable(),
  joinedAt: z.string(),
});

// Shared path-params schema for the `(groupType, groupKey)` natural key — the
// same shape the get / add-member / remove-member / list-members routes address
// a group by. `remove-member` extends it with the `contactId` segment.
const groupKeyParams = z.object({
  groupType: z.string().min(1),
  groupKey: z.string().min(1),
});

const identifyRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Groups"],
  summary: "Identify (upsert) a group",
  description:
    "Resolves (create / merge) a group by its (groupType, groupKey) natural key, merges `properties` onto the group's property bag (new keys win), and best-effort mirrors the property write to the active analytics provider (PostHog groupIdentify).",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            groupType: z.string().min(1),
            groupKey: z.string().min(1),
            displayName: z.string().optional(),
            properties: z.record(z.string(), z.unknown()).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ group: groupSchema }),
        },
      },
      description: "Group identified",
    },
  },
});

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Groups"],
  summary: "List groups",
  description:
    "Newest-seen first. Filter with `groupType`; paginate with `limit` (default 50, max 200) + `offset`.",
  request: {
    query: z.object({
      groupType: z.string().optional(),
      limit: z.coerce.number().optional(),
      offset: z.coerce.number().optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ groups: z.array(groupSchema) }),
        },
      },
      description: "Groups, newest-seen first",
    },
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/{groupType}/{groupKey}",
  tags: ["Groups"],
  summary: "Get a group",
  request: {
    params: groupKeyParams,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ group: groupSchema }),
        },
      },
      description: "The group",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Unknown group",
    },
  },
});

const addMemberRoute = createRoute({
  method: "post",
  path: "/{groupType}/{groupKey}/members",
  tags: ["Groups"],
  summary: "Add a member to a group",
  description:
    "Resolve-or-create the group, then add the contact as a member. `created` reflects whether THIS call inserted the membership (a re-add of an existing member returns `created:false`).",
  request: {
    params: groupKeyParams,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            // Bound to a `uuid` contacts column — validate the shape here so a
            // malformed id is a 400 (not a 22P02 500), and a well-formed but
            // nonexistent id is caught by the service's existence guard → 404.
            contactId: z.string().uuid(),
            role: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            membership: membershipSchema,
            created: z.boolean(),
          }),
        },
      },
      description: "Membership resolved",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Unknown contact",
    },
  },
});

const removeMemberRoute = createRoute({
  method: "delete",
  path: "/{groupType}/{groupKey}/members/{contactId}",
  tags: ["Groups"],
  summary: "Remove a member from a group",
  description:
    "Hard-deletes the membership. `removed` is false when the group or membership did not exist.",
  request: {
    params: groupKeyParams.extend({
      // Bound to a `uuid` contacts column — a malformed id is a 400 here rather
      // than a 22P02 500 in the delete's WHERE clause.
      contactId: z.string().uuid(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ removed: z.boolean() }),
        },
      },
      description: "Membership removal result",
    },
  },
});

const listMembersRoute = createRoute({
  method: "get",
  path: "/{groupType}/{groupKey}/members",
  tags: ["Groups"],
  summary: "List a group's members",
  description:
    "Newest-joined first, joined to each member's live contact. Returns an empty list when the group does not exist.",
  request: {
    params: groupKeyParams,
    query: z.object({
      limit: z.coerce.number().optional(),
      offset: z.coerce.number().optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ members: z.array(memberSchema) }),
        },
      },
      description: "The group's members, newest-joined first",
    },
  },
});

// The groups router does NOT re-apply auth internally — the data-plane prefix
// guards in `routes/index.ts` apply `requireApiKey` + `requireScope("ingest")`
// to `/v1/groups` (bare + `/*`) before requests reach this router. The whole
// surface (group property writes, membership mutations, AND reads) is operator
// data, so it is secret-key only; a browser (pk_) key associates groups ONLY by
// attaching a `groups` map to an ingested event on `/v1/events`.
export const groupsRouter = new OpenAPIHono<AppEnv>()
  .openapi(identifyRoute, async (c) => {
    const { db, analytics, hatchet, logger } = c.get("container");
    const body = c.req.valid("json");

    const { group } = await identifyGroup({
      db,
      groupType: body.groupType,
      groupKey: body.groupKey,
      displayName: body.displayName,
      properties: body.properties,
      analytics,
    });

    const serialized = serializeGroup(group);

    // INTENT-LAYER outbound emit (Phase 5): an explicit identify is intent, so
    // fire `group.identified` on every success. NEVER emitted from the group
    // service / ingest `associateGroups` path (a pageview-driven association
    // would flood) — mirrors the contacts intent-layer rule.
    void emitOutbound({
      db,
      hatchet,
      logger,
      event: "group.identified",
      payload: serialized,
    }).catch(logger.warn);

    return c.json({ group: serialized }, 200);
  })
  .openapi(listRoute, async (c) => {
    const { db } = c.get("container");
    const { groupType, limit, offset } = c.req.valid("query");

    const { groups } = await listGroups({ db, groupType, limit, offset });

    return c.json({ groups: groups.map(serializeGroup) }, 200);
  })
  .openapi(getRoute, async (c) => {
    const { db } = c.get("container");
    const { groupType, groupKey } = c.req.valid("param");

    const { group } = await getGroup({ db, groupType, groupKey });
    if (!group) {
      return c.json({ error: `Unknown group: ${groupType}/${groupKey}` }, 404);
    }

    return c.json({ group: serializeGroup(group) }, 200);
  })
  .openapi(addMemberRoute, async (c) => {
    const { db, hatchet, logger } = c.get("container");
    const { groupType, groupKey } = c.req.valid("param");
    const { contactId, role } = c.req.valid("json");

    let result: Awaited<ReturnType<typeof addGroupMember>>;
    try {
      result = await addGroupMember({
        db,
        groupType,
        groupKey,
        contactId,
        role,
      });
    } catch (err) {
      // A well-formed but nonexistent (or soft-deleted) contact is rejected by
      // the service BEFORE any group is created — surface as 404, no orphan group.
      if (err instanceof GroupContactNotFoundError) {
        return c.json({ error: err.message }, 404);
      }
      throw err;
    }
    const { membership, created } = result;

    // INTENT-LAYER outbound emit (Phase 5): fire `group.member_added` ONLY when
    // THIS call inserted the membership — a re-add (`created:false`) is a no-op.
    if (created) {
      void emitOutbound({
        db,
        hatchet,
        logger,
        event: "group.member_added",
        payload: {
          groupType,
          groupKey,
          groupId: membership.groupId,
          contactId: membership.contactId,
          role: membership.role,
        },
      }).catch(logger.warn);
    }

    return c.json(
      {
        membership: {
          id: membership.id,
          groupId: membership.groupId,
          contactId: membership.contactId,
          role: membership.role,
          joinedAt: membership.joinedAt.toISOString(),
        },
        created,
      },
      200,
    );
  })
  .openapi(removeMemberRoute, async (c) => {
    const { db, hatchet, logger } = c.get("container");
    const { groupType, groupKey, contactId } = c.req.valid("param");

    // Resolve the live group up-front so a successful removal's outbound payload
    // can carry `groupId` — the service returns only `{ removed }`, and we do
    // NOT widen its core contract. A missing group makes the remove a no-op.
    const { group } = await getGroup({ db, groupType, groupKey });

    const { removed } = await removeGroupMember({
      db,
      groupType,
      groupKey,
      contactId,
    });

    // INTENT-LAYER outbound emit (Phase 5): fire `group.member_removed` ONLY
    // when a membership row was actually deleted. `group` is present whenever
    // `removed` is true (the row is deleted from an existing group).
    if (removed && group) {
      void emitOutbound({
        db,
        hatchet,
        logger,
        event: "group.member_removed",
        payload: { groupType, groupKey, groupId: group.id, contactId },
      }).catch(logger.warn);
    }

    return c.json({ removed }, 200);
  })
  .openapi(listMembersRoute, async (c) => {
    const { db } = c.get("container");
    const { groupType, groupKey } = c.req.valid("param");
    const { limit, offset } = c.req.valid("query");

    const { members } = await listGroupMembers({
      db,
      groupType,
      groupKey,
      limit,
      offset,
    });

    return c.json(
      {
        members: members.map((m) => ({
          contactId: m.contactId,
          email: m.email,
          externalId: m.externalId,
          role: m.role,
          joinedAt: m.joinedAt.toISOString(),
        })),
      },
      200,
    );
  });
