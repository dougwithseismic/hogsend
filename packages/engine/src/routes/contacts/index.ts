import type { contacts as contactsTable } from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import {
  findContacts,
  resolveOrCreateContact,
  softDeleteContact,
} from "../../lib/contacts.js";
import { applyListMembership } from "../../lib/preferences.js";

// The public, serialized contact shape (§2.5). `externalId` is nullable (D1 —
// email-only / anonymous contacts) and timestamps are ISO strings.
const contactSchema = z.object({
  id: z.string(),
  externalId: z.string().nullable(),
  email: z.string().nullable(),
  properties: z.record(z.string(), z.unknown()),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const errorSchema = z.object({ error: z.string() });

const upsertRoute = createRoute({
  method: "put",
  path: "/",
  tags: ["Contacts"],
  summary: "Upsert a contact",
  description:
    "Resolves (create / fill-in-link / merge) a contact by email and/or userId, applies contactProperties, and optionally writes list membership.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            email: z.string().email().optional(),
            userId: z.string().min(1).optional(),
            properties: z.record(z.string(), z.unknown()).optional(),
            lists: z.record(z.string(), z.boolean()).optional(),
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
            id: z.string(),
            created: z.boolean(),
            linked: z.boolean(),
          }),
        },
      },
      description: "Contact resolved",
    },
    400: {
      content: { "application/json": { schema: errorSchema } },
      description: "Missing recipient or unmanageable list membership",
    },
  },
});

const findRoute = createRoute({
  method: "get",
  path: "/find",
  tags: ["Contacts"],
  summary: "Find contacts by email or userId",
  request: {
    query: z.object({
      email: z.string().optional(),
      userId: z.string().optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ contacts: z.array(contactSchema) }),
        },
      },
      description: "Matching contacts (non-deleted)",
    },
    400: {
      content: { "application/json": { schema: errorSchema } },
      description: "Missing query key",
    },
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/",
  tags: ["Contacts"],
  summary: "Soft-delete a contact",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            email: z.string().optional(),
            userId: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ deleted: z.literal(true) }),
        },
      },
      description: "Contact soft-deleted",
    },
    400: {
      content: { "application/json": { schema: errorSchema } },
      description: "Missing recipient key",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Contact not found",
    },
  },
});

function serializeContact(row: typeof contactsTable.$inferSelect) {
  return {
    id: row.id,
    externalId: row.externalId,
    email: row.email,
    properties: (row.properties ?? {}) as Record<string, unknown>,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const contactsRouter = new OpenAPIHono<AppEnv>()
  .openapi(upsertRoute, async (c) => {
    const { db } = c.get("container");
    const body = c.req.valid("json");

    if (!body.email && !body.userId) {
      return c.json({ error: "email or userId is required" }, 400);
    }

    const { id, created, linked } = await resolveOrCreateContact({
      db,
      userId: body.userId,
      email: body.email,
      contactProperties: body.properties,
    });

    // Lists applied AFTER the resolve so the contact exists (§2.5 lists
    // ordering). `applyListMembership` requires a resolvable email — surface the
    // "no email" case as a 400 rather than a 500.
    if (body.lists && Object.keys(body.lists).length > 0) {
      try {
        await applyListMembership({
          db,
          userId: body.userId,
          email: body.email,
          lists: body.lists,
        });
      } catch (err) {
        return c.json(
          {
            error:
              err instanceof Error
                ? err.message
                : "Failed to apply list membership",
          },
          400,
        );
      }
    }

    return c.json({ id, created, linked }, 200);
  })
  .openapi(findRoute, async (c) => {
    const { db } = c.get("container");
    const { email, userId } = c.req.valid("query");

    if (!email && !userId) {
      return c.json({ error: "email or userId is required" }, 400);
    }

    const rows = await findContacts({ db, email, userId });

    return c.json({ contacts: rows.map(serializeContact) }, 200);
  })
  .openapi(deleteRoute, async (c) => {
    const { db } = c.get("container");
    const { email, userId } = c.req.valid("json");

    if (!email && !userId) {
      return c.json({ error: "email or userId is required" }, 400);
    }

    const deleted = await softDeleteContact({ db, email, userId });
    if (!deleted) {
      return c.json({ error: "Contact not found" }, 404);
    }

    return c.json({ deleted: true as const }, 200);
  });
