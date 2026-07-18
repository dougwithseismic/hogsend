import {
  type FlagVariant,
  flagCreateSchema,
  flagUpdateSchema,
  type PropertyCondition,
} from "@hogsend/core";
import { flags } from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { AppEnv } from "../../app.js";
import { errorSchema } from "../../lib/schemas.js";

/**
 * Admin CRUD over the sovereign `flags` table (the Studio authoring surface).
 * Inherits the admin router's `requireAdmin` guard, so it never re-auths here.
 * Archive is a soft-delete (`archivedAt`) that frees the flag's key for reuse
 * via the partial-unique live-row index.
 */

const flagVariantSchema = z.object({
  key: z.string(),
  value: z.unknown(),
  weight: z.number(),
});

const propertyConditionSchema = z.object({
  type: z.literal("property"),
  property: z.string(),
  operator: z.string(),
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

const flagSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  enabled: z.boolean(),
  type: z.string(),
  variants: z.array(flagVariantSchema),
  defaultValue: z.unknown(),
  targeting: z.array(propertyConditionSchema),
  rollout: z.number(),
  origin: z.string(),
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

function serializeFlag(row: typeof flags.$inferSelect) {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description ?? null,
    enabled: row.enabled,
    type: row.type,
    variants: row.variants as FlagVariant[],
    defaultValue: row.defaultValue,
    targeting: row.targeting as PropertyCondition[],
    rollout: row.rollout,
    origin: row.origin,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin — Flags"],
  summary: "List flags",
  request: {
    query: z.object({
      includeArchived: z.coerce.boolean().optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ flags: z.array(flagSchema) }),
        },
      },
      description: "Flags",
    },
  },
});

const createFlagRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Admin — Flags"],
  summary: "Create a flag",
  request: {
    body: { content: { "application/json": { schema: flagCreateSchema } } },
  },
  responses: {
    201: {
      content: {
        "application/json": { schema: z.object({ flag: flagSchema }) },
      },
      description: "Flag created",
    },
    409: {
      content: { "application/json": { schema: errorSchema } },
      description: "A live flag with that key already exists",
    },
  },
});

const updateFlagRoute = createRoute({
  method: "patch",
  path: "/{id}",
  tags: ["Admin — Flags"],
  summary: "Update a flag (toggle enabled, edit targeting/rollout/variants)",
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: { content: { "application/json": { schema: flagUpdateSchema } } },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: z.object({ flag: flagSchema }) },
      },
      description: "Flag updated",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Flag not found",
    },
  },
});

const archiveFlagRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Admin — Flags"],
  summary: "Archive a flag (soft-delete; frees the key)",
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ archived: z.boolean() }),
        },
      },
      description: "Flag archived",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Flag not found",
    },
  },
});

export const adminFlagsRouter = new OpenAPIHono<AppEnv>()
  .openapi(listRoute, async (c) => {
    const { db } = c.get("container");
    const { includeArchived } = c.req.valid("query");
    const rows = await db
      .select()
      .from(flags)
      .where(includeArchived ? undefined : isNull(flags.archivedAt))
      .orderBy(desc(flags.createdAt));
    return c.json({ flags: rows.map(serializeFlag) }, 200);
  })
  .openapi(createFlagRoute, async (c) => {
    const { db } = c.get("container");
    const body = c.req.valid("json");

    // Enforce the live-key uniqueness explicitly for a friendly 409 (the
    // partial-unique index is the ultimate backstop).
    const existing = await db
      .select({ id: flags.id })
      .from(flags)
      .where(and(eq(flags.key, body.key), isNull(flags.archivedAt)))
      .limit(1);
    if (existing[0]) {
      return c.json({ error: "A live flag with that key already exists" }, 409);
    }

    // A boolean flag's default is `false` when unspecified (the spec's served
    // value when disabled / targeting fails / outside the rollout).
    const defaultValue =
      body.defaultValue !== undefined
        ? body.defaultValue
        : body.type === "boolean"
          ? false
          : null;

    const [created] = await db
      .insert(flags)
      .values({
        key: body.key,
        name: body.name,
        description: body.description,
        enabled: body.enabled,
        type: body.type,
        variants: body.variants ?? [],
        defaultValue,
        targeting: body.targeting ?? [],
        rollout: body.rollout,
      })
      .returning();
    if (!created) throw new Error("Failed to create flag");
    return c.json({ flag: serializeFlag(created) }, 201);
  })
  .openapi(updateFlagRoute, async (c) => {
    const { db } = c.get("container");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");

    const rows = await db.select().from(flags).where(eq(flags.id, id)).limit(1);
    if (!rows[0]) return c.json({ error: "Flag not found" }, 404);

    const [updated] = await db
      .update(flags)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined
          ? { description: body.description }
          : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.type !== undefined ? { type: body.type } : {}),
        ...(body.variants !== undefined ? { variants: body.variants } : {}),
        ...(body.defaultValue !== undefined
          ? { defaultValue: body.defaultValue }
          : {}),
        ...(body.targeting !== undefined ? { targeting: body.targeting } : {}),
        ...(body.rollout !== undefined ? { rollout: body.rollout } : {}),
        updatedAt: new Date(),
      })
      .where(eq(flags.id, id))
      .returning();
    if (!updated) throw new Error("Failed to update flag");
    return c.json({ flag: serializeFlag(updated) }, 200);
  })
  .openapi(archiveFlagRoute, async (c) => {
    const { db } = c.get("container");
    const { id } = c.req.valid("param");

    const rows = await db
      .select()
      .from(flags)
      .where(and(eq(flags.id, id), isNull(flags.archivedAt)))
      .limit(1);
    if (!rows[0]) return c.json({ error: "Flag not found" }, 404);

    await db
      .update(flags)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(eq(flags.id, id));
    return c.json({ archived: true }, 200);
  });
