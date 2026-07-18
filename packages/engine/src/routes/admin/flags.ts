import {
  type ConditionSet,
  type FlagCreateInput,
  type FlagTargeting,
  type FlagUpdateInput,
  type FlagVariant,
  flagConditionSetSchema,
  flagCreateSchema,
  flagTargetingSchema,
  flagUpdateSchema,
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

const flagSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  enabled: z.boolean(),
  type: z.string(),
  variants: z.array(flagVariantSchema),
  defaultValue: z.unknown(),
  targeting: flagTargetingSchema,
  rollout: z.number(),
  conditionSets: z.array(flagConditionSetSchema),
  origin: z.string(),
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * Normalize a write body's targeting to the coherent pair the columns store:
 * the ordered `conditionSets` (authoritative) AND the legacy `targeting`+
 * `rollout` (synthesized from `conditionSets[0]` for readers that still read
 * them). `conditionSets` wins when present; otherwise a single set is built
 * from the legacy fields (an omitted `rollout` defaults to 100).
 */
function normalizeWrite(body: FlagCreateInput | FlagUpdateInput): {
  conditionSets: ConditionSet[];
  targeting: FlagTargeting;
  rollout: number;
} {
  const first = body.conditionSets?.[0];
  if (body.conditionSets && first) {
    return {
      conditionSets: body.conditionSets,
      targeting: first.targeting as FlagTargeting,
      rollout: first.rollout,
    };
  }
  const targeting = (body.targeting ?? []) as FlagTargeting;
  const rollout = body.rollout ?? 100;
  return { conditionSets: [{ targeting, rollout }], targeting, rollout };
}

function serializeFlag(row: typeof flags.$inferSelect) {
  // Back-compat synthesis: a flag that predates condition sets (NULL column)
  // reads as a single set built from the legacy targeting+rollout columns.
  const conditionSets: ConditionSet[] = (row.conditionSets as
    | ConditionSet[]
    | null) ?? [
    { targeting: row.targeting as FlagTargeting, rollout: row.rollout },
  ];
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description ?? null,
    enabled: row.enabled,
    type: row.type,
    variants: row.variants as FlagVariant[],
    defaultValue: row.defaultValue,
    targeting: row.targeting as FlagTargeting,
    rollout: row.rollout,
    conditionSets,
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
    409: {
      content: { "application/json": { schema: errorSchema } },
      description: "A live flag with that key already exists",
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

    const write = normalizeWrite(body);
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
        targeting: write.targeting,
        rollout: write.rollout,
        conditionSets: write.conditionSets,
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

    // A key rename must stay unique among LIVE flags (the partial-unique index
    // is the backstop; this is the friendly 409). Skip when the key is
    // unchanged so re-saving the same flag never self-collides.
    if (body.key !== undefined && body.key !== rows[0].key) {
      const clash = await db
        .select({ id: flags.id })
        .from(flags)
        .where(and(eq(flags.key, body.key), isNull(flags.archivedAt)))
        .limit(1);
      if (clash[0]) {
        return c.json(
          { error: "A live flag with that key already exists" },
          409,
        );
      }
    }

    // Targeting write: recompute the coherent (conditionSets + legacy) triple
    // when the caller touches ANY of conditionSets/targeting/rollout. An
    // explicit `conditionSets` is authoritative. A legacy-field-only edit (bare
    // targeting/rollout) merges into the EXISTING first set and PRESERVES
    // sets[1..], so a rollout bump on a multi-set flag never silently destroys
    // its other sets. The legacy `targeting`/`rollout` columns mirror set[0].
    const touchesTargeting =
      body.conditionSets !== undefined ||
      body.targeting !== undefined ||
      body.rollout !== undefined;
    let targetingWrite:
      | {
          conditionSets: ConditionSet[];
          targeting: FlagTargeting;
          rollout: number;
        }
      | undefined;
    if (touchesTargeting) {
      const first = body.conditionSets?.[0];
      if (body.conditionSets && first) {
        targetingWrite = {
          conditionSets: body.conditionSets,
          targeting: first.targeting as FlagTargeting,
          rollout: first.rollout,
        };
      } else {
        // Existing sets to merge into (back-compat: a NULL column synthesizes a
        // single set from the legacy targeting+rollout columns).
        const existing = rows[0].conditionSets as ConditionSet[] | null;
        const base =
          existing && existing.length > 0
            ? existing
            : [
                {
                  targeting: rows[0].targeting as FlagTargeting,
                  rollout: rows[0].rollout,
                },
              ];
        const targeting = (body.targeting ??
          base[0]?.targeting ??
          rows[0].targeting) as FlagTargeting;
        const rollout = body.rollout ?? base[0]?.rollout ?? rows[0].rollout;
        targetingWrite = {
          conditionSets: [{ targeting, rollout }, ...base.slice(1)],
          targeting,
          rollout,
        };
      }
    }

    const [updated] = await db
      .update(flags)
      .set({
        ...(body.key !== undefined ? { key: body.key } : {}),
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
        ...(targetingWrite
          ? {
              targeting: targetingWrite.targeting,
              rollout: targetingWrite.rollout,
              conditionSets: targetingWrite.conditionSets,
            }
          : {}),
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
