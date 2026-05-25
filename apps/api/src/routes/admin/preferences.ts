import { contacts, type Database, emailPreferences } from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../../app.js";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const preferencesResponseSchema = z.object({
  id: z.string(),
  userId: z.string(),
  email: z.string(),
  unsubscribedAll: z.boolean(),
  suppressed: z.boolean(),
  bounceCount: z.number(),
  categories: z.record(z.string(), z.boolean()),
  suppressedAt: z.string().nullable(),
  lastBounceAt: z.string().nullable(),
});

const getPrefsRoute = createRoute({
  method: "get",
  path: "/{contactId}/preferences",
  tags: ["Admin"],
  summary: "Get email preferences for a contact",
  request: {
    params: z.object({ contactId: z.string() }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ preferences: preferencesResponseSchema }),
        },
      },
      description: "Email preferences",
    },
    404: {
      content: {
        "application/json": {
          schema: z.object({ error: z.string() }),
        },
      },
      description: "Contact or preferences not found",
    },
  },
});

const updatePrefsRoute = createRoute({
  method: "put",
  path: "/{contactId}/preferences",
  tags: ["Admin"],
  summary: "Update email preferences for a contact",
  request: {
    params: z.object({ contactId: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            unsubscribedAll: z.boolean().optional(),
            suppressed: z.boolean().optional(),
            categories: z.record(z.string(), z.boolean()).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ preferences: preferencesResponseSchema }),
        },
      },
      description: "Preferences updated",
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

async function resolveContact(db: Database, contactId: string) {
  const where = UUID_REGEX.test(contactId)
    ? eq(contacts.id, contactId)
    : eq(contacts.externalId, contactId);

  const rows = await db.select().from(contacts).where(where).limit(1);
  return rows[0] ?? null;
}

function serializePrefs(row: typeof emailPreferences.$inferSelect) {
  return {
    id: row.id,
    userId: row.userId,
    email: row.email,
    unsubscribedAll: row.unsubscribedAll,
    suppressed: row.suppressed,
    bounceCount: row.bounceCount,
    categories: (row.categories ?? {}) as Record<string, boolean>,
    suppressedAt: row.suppressedAt?.toISOString() ?? null,
    lastBounceAt: row.lastBounceAt?.toISOString() ?? null,
  };
}

export const preferencesRouter = new OpenAPIHono<AppEnv>()
  .openapi(getPrefsRoute, async (c) => {
    const { db } = c.get("container");
    const { contactId } = c.req.valid("param");

    const contact = await resolveContact(db, contactId);
    if (!contact) {
      return c.json({ error: "Contact not found" }, 404);
    }

    const rows = await db
      .select()
      .from(emailPreferences)
      .where(eq(emailPreferences.userId, contact.externalId))
      .limit(1);

    if (rows.length === 0) {
      return c.json({ error: "No preferences found for this contact" }, 404);
    }

    const prefs = rows[0] as typeof emailPreferences.$inferSelect;
    return c.json({ preferences: serializePrefs(prefs) }, 200);
  })
  .openapi(updatePrefsRoute, async (c) => {
    const { db } = c.get("container");
    const { contactId } = c.req.valid("param");
    const body = c.req.valid("json");

    const contact = await resolveContact(db, contactId);
    if (!contact) {
      return c.json({ error: "Contact not found" }, 404);
    }

    const [upserted] = await db
      .insert(emailPreferences)
      .values({
        userId: contact.externalId,
        email: contact.email ?? "",
        unsubscribedAll: body.unsubscribedAll ?? false,
        suppressed: body.suppressed ?? false,
        categories: body.categories ?? {},
      })
      .onConflictDoUpdate({
        target: [emailPreferences.userId, emailPreferences.email],
        set: {
          ...(body.unsubscribedAll !== undefined
            ? { unsubscribedAll: body.unsubscribedAll }
            : {}),
          ...(body.suppressed !== undefined
            ? {
                suppressed: body.suppressed,
                suppressedAt: body.suppressed ? new Date() : null,
              }
            : {}),
          ...(body.categories !== undefined
            ? { categories: body.categories }
            : {}),
          updatedAt: new Date(),
        },
      })
      .returning();

    if (!upserted) {
      throw new Error("Failed to upsert preferences");
    }

    return c.json({ preferences: serializePrefs(upserted) }, 200);
  });
