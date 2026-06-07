import { contacts, emailPreferences } from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, count, desc, eq, isNull, sql } from "drizzle-orm";
import type { AppEnv } from "../../app.js";
import {
  contactSearchFilter,
  resolveContact,
  resolveOrCreateContact,
  serializePrefs,
} from "../../lib/contacts.js";

const contactSchema = z.object({
  id: z.string(),
  externalId: z.string().nullable(),
  anonymousId: z.string().nullable(),
  email: z.string().nullable(),
  properties: z.record(z.string(), z.unknown()),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const preferencesSchema = z
  .object({
    id: z.string(),
    userId: z.string(),
    email: z.string(),
    unsubscribedAll: z.boolean(),
    suppressed: z.boolean(),
    bounceCount: z.number(),
    categories: z.record(z.string(), z.boolean()),
  })
  .nullable();

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin"],
  summary: "List contacts",
  request: {
    query: z.object({
      limit: z.coerce.number().min(1).max(100).default(50),
      offset: z.coerce.number().min(0).default(0),
      search: z.string().optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            contacts: z.array(contactSchema),
            total: z.number(),
            limit: z.number(),
            offset: z.number(),
          }),
        },
      },
      description: "Paginated contact list",
    },
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Admin"],
  summary: "Get contact by ID or externalId",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            contact: contactSchema,
            preferences: preferencesSchema,
          }),
        },
      },
      description: "Contact with preferences",
    },
    404: {
      content: {
        "application/json": {
          schema: z.object({ error: z.string() }),
        },
      },
      description: "Contact not found",
    },
  },
});

const createRoute_ = createRoute({
  method: "post",
  path: "/",
  tags: ["Admin"],
  summary: "Create or upsert a contact",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              externalId: z.string().min(1).optional(),
              email: z.string().email().optional(),
              properties: z.record(z.string(), z.unknown()).optional(),
            })
            .refine((b) => Boolean(b.externalId || b.email), {
              message: "Provide at least one of externalId or email",
            }),
        },
      },
    },
  },
  responses: {
    201: {
      content: {
        "application/json": {
          schema: z.object({ contact: contactSchema }),
        },
      },
      description: "Contact created or upserted",
    },
    400: {
      content: {
        "application/json": {
          schema: z.object({ error: z.string() }),
        },
      },
      description: "Missing identity (externalId or email required)",
    },
  },
});

const updateRoute = createRoute({
  method: "patch",
  path: "/{id}",
  tags: ["Admin"],
  summary: "Update a contact",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            email: z.string().email().optional(),
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
          schema: z.object({ contact: contactSchema }),
        },
      },
      description: "Contact updated",
    },
    404: {
      content: {
        "application/json": {
          schema: z.object({ error: z.string() }),
        },
      },
      description: "Contact not found",
    },
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Admin"],
  summary: "Delete a contact",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ deleted: z.boolean() }),
        },
      },
      description: "Contact deleted",
    },
    404: {
      content: {
        "application/json": {
          schema: z.object({ error: z.string() }),
        },
      },
      description: "Contact not found",
    },
  },
});

function serializeContact(row: typeof contacts.$inferSelect) {
  return {
    id: row.id,
    externalId: row.externalId,
    anonymousId: row.anonymousId,
    email: row.email,
    properties: (row.properties ?? {}) as Record<string, unknown>,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const contactsRouter = new OpenAPIHono<AppEnv>()
  .openapi(listRoute, async (c) => {
    const { db } = c.get("container");
    const { limit, offset, search } = c.req.valid("query");

    const searchFilter = search ? contactSearchFilter(search) : undefined;

    const where = searchFilter
      ? and(searchFilter, isNull(contacts.deletedAt))
      : isNull(contacts.deletedAt);

    const [rows, totalRows] = await Promise.all([
      db
        .select()
        .from(contacts)
        .where(where)
        .orderBy(desc(contacts.lastSeenAt))
        .limit(limit)
        .offset(offset),
      db.select({ count: count() }).from(contacts).where(where),
    ]);

    return c.json(
      {
        contacts: rows.map(serializeContact),
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

    const contact = await resolveContact({ db, id });
    if (!contact) {
      return c.json({ error: "Contact not found" }, 404);
    }

    // email_preferences.user_id uses external_id when present, else the contact
    // uuid as the deterministic fallback (risk 10 — email-only contacts).
    const prefRows = await db
      .select()
      .from(emailPreferences)
      .where(eq(emailPreferences.userId, contact.externalId ?? contact.id))
      .limit(1);

    const prefs = prefRows[0] ? serializePrefs(prefRows[0]) : null;

    return c.json(
      { contact: serializeContact(contact), preferences: prefs },
      200,
    );
  })
  .openapi(createRoute_, async (c) => {
    const { db } = c.get("container");
    const body = c.req.valid("json");

    // Delegate to the identity resolver (D1): it upserts/merges on the provided
    // identity keys (externalId and/or email), so the hand-rolled existence
    // check + raw insert + 409 are gone (§5). Read the row back to serialize.
    const { id } = await resolveOrCreateContact({
      db,
      userId: body.externalId,
      email: body.email,
      contactProperties: body.properties,
    });

    const created = await resolveContact({ db, id });
    if (!created) {
      throw new Error("Failed to create contact");
    }

    return c.json({ contact: serializeContact(created) }, 201);
  })
  .openapi(updateRoute, async (c) => {
    const { db } = c.get("container");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");

    const current = await resolveContact({ db, id });
    if (!current) {
      return c.json({ error: "Contact not found" }, 404);
    }

    const hasIdentityKey = Boolean(
      current.externalId || current.anonymousId || body.email || current.email,
    );

    if (hasIdentityKey) {
      // Delegate the email-fill + property merge to the resolver, keyed on the
      // contact's canonical identity so the COALESCE||patch merge lives in one
      // place (§5). Passing the existing externalId/anonymousId/email keeps the
      // resolver on the fill-in-link path; a NEW email that already belongs to
      // another contact correctly merges (the partial-unique index would have
      // rejected a blind set anyway).
      await resolveOrCreateContact({
        db,
        userId: current.externalId ?? undefined,
        email: body.email ?? current.email ?? undefined,
        anonymousId: current.anonymousId ?? undefined,
        contactProperties: body.properties,
      });
    } else {
      // Degenerate contact with no identity keys (resolver requires >=1 key):
      // update it directly by uuid.
      await db
        .update(contacts)
        .set({
          ...(body.properties
            ? {
                properties: sql`COALESCE(${contacts.properties}, '{}'::jsonb) || ${JSON.stringify(body.properties)}::jsonb`,
              }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(contacts.id, current.id));
    }

    const updated = await resolveContact({ db, id });
    if (!updated) {
      throw new Error("Failed to update contact");
    }

    return c.json({ contact: serializeContact(updated) }, 200);
  })
  .openapi(deleteRoute, async (c) => {
    const { db } = c.get("container");
    const { id } = c.req.valid("param");

    const contact = await resolveContact({ db, id });
    if (!contact) {
      return c.json({ error: "Contact not found" }, 404);
    }

    await db
      .update(contacts)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(contacts.id, contact.id));

    return c.json({ deleted: true }, 200);
  });
