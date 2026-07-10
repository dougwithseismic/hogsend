import { journeySpecs } from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { asc, eq, sql } from "drizzle-orm";
import { ZodError } from "zod";
import type { AppEnv } from "../../app.js";
import { validateJourneySpec } from "../../journeys/spec/journey-from-spec.js";
import { getRuntimeSpecStore } from "../../journeys/spec/runtime-spec-store.js";

/**
 * Admin CRUD for DB-stored journey specs (Slice 1). Every write is validated
 * with the SAME `validateJourneySpec` the boot loader trusts, so a stored row is
 * always valid-at-write. Code wins: an id already owned by a CODE journey (in
 * the registry but with no `journey_specs` row) is refused.
 *
 * NOTE (Slice 1 limitation): a create/edit takes effect on the NEXT worker boot
 * — the worker registers a durable Hatchet task per journey at startup. The
 * generic-dispatch pivot (Slice 2) is what makes a new spec fire without a
 * restart.
 */

const errorSchema = z.object({ error: z.string() });

const specSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  origin: z.enum(["code", "json"]),
  version: z.number(),
  specSchemaVersion: z.number(),
  updatedAt: z.string(),
});

// The spec body is validated in the handler (the recursive JourneySpec schema
// doesn't round-trip cleanly through OpenAPI generation), so the documented
// request shape is an open object.
const specBodySchema = z.record(z.string(), z.unknown());

function summarize(row: typeof journeySpecs.$inferSelect) {
  const meta = (row.spec as { meta?: { name?: string } }).meta;
  return {
    id: row.journeyId,
    name: meta?.name ?? row.journeyId,
    enabled: row.enabled,
    origin: row.origin,
    version: row.version,
    specSchemaVersion: row.specSchemaVersion,
    updatedAt: row.updatedAt.toISOString(),
  };
}

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin — Journey Specs"],
  summary: "List DB-stored journey specs",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ specs: z.array(specSummarySchema) }),
        },
      },
      description: "All stored journey specs",
    },
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Admin — Journey Specs"],
  summary: "Get one stored journey spec (full document)",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            summary: specSummarySchema,
            spec: specBodySchema,
          }),
        },
      },
      description: "The stored spec document",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Spec not found",
    },
  },
});

const putRoute = createRoute({
  method: "put",
  path: "/{id}",
  tags: ["Admin — Journey Specs"],
  summary: "Create or replace a journey spec",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: { "application/json": { schema: specBodySchema } },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            spec: specSummarySchema,
            created: z.boolean(),
          }),
        },
      },
      description:
        "Spec stored (created or replaced; version bumped on replace)",
    },
    400: {
      content: { "application/json": { schema: errorSchema } },
      description: "Spec failed validation, or its id disagrees with the path",
    },
    409: {
      content: { "application/json": { schema: errorSchema } },
      description: "Id is owned by a code journey (code wins)",
    },
  },
});

const patchRoute = createRoute({
  method: "patch",
  path: "/{id}",
  tags: ["Admin — Journey Specs"],
  summary: "Enable or disable a stored journey spec",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": { schema: z.object({ enabled: z.boolean() }) },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: z.object({ spec: specSummarySchema }) },
      },
      description: "Spec updated",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Spec not found",
    },
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Admin — Journey Specs"],
  summary: "Delete a stored journey spec",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ deleted: z.boolean(), id: z.string() }),
        },
      },
      description: "Spec deleted",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Spec not found",
    },
  },
});

export const journeySpecsRouter = new OpenAPIHono<AppEnv>()
  .openapi(listRoute, async (c) => {
    const { db } = c.get("container");
    const rows = await db
      .select()
      .from(journeySpecs)
      .orderBy(asc(journeySpecs.journeyId));
    return c.json({ specs: rows.map(summarize) }, 200);
  })
  .openapi(getRoute, async (c) => {
    const { db } = c.get("container");
    const { id } = c.req.valid("param");
    const [row] = await db
      .select()
      .from(journeySpecs)
      .where(eq(journeySpecs.journeyId, id))
      .limit(1);
    if (!row) return c.json({ error: "Spec not found" }, 404);
    return c.json(
      { summary: summarize(row), spec: row.spec as Record<string, unknown> },
      200,
    );
  })
  .openapi(putRoute, async (c) => {
    const { db, registry, templates } = c.get("container");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");

    // Validate exactly as the boot loader does — shape + referential + template
    // keys. A dead template is rejected here rather than silently skipped later.
    const templateKeys = new Set(Object.keys(templates ?? {}));
    let spec: ReturnType<typeof validateJourneySpec>;
    try {
      spec = validateJourneySpec(body, { templateKeys });
    } catch (err) {
      const message =
        err instanceof ZodError
          ? err.issues
              .map((i) => `${i.path.join(".")}: ${i.message}`)
              .join("; ")
          : err instanceof Error
            ? err.message
            : String(err);
      return c.json({ error: `Invalid spec: ${message}` }, 400);
    }

    if (spec.id !== id) {
      return c.json(
        { error: `Spec id "${spec.id}" does not match path id "${id}"` },
        400,
      );
    }

    const [existing] = await db
      .select({ version: journeySpecs.version })
      .from(journeySpecs)
      .where(eq(journeySpecs.journeyId, id))
      .limit(1);

    // Code wins: an id registered but WITHOUT a journey_specs row belongs to a
    // code journey. (An existing DB spec is always in the registry too, but it
    // has a row, so this only trips for genuine code journeys.)
    if (!existing && registry.has(id)) {
      return c.json(
        {
          error: `Journey id "${id}" is defined by a code journey; code journeys win and cannot be shadowed by a stored spec.`,
        },
        409,
      );
    }

    const [row] = await db
      .insert(journeySpecs)
      .values({
        journeyId: id,
        // biome-ignore lint/suspicious/noExplicitAny: validated JourneySpec → jsonb
        spec: spec as any,
        specSchemaVersion: spec.specVersion,
        origin: "json",
      })
      .onConflictDoUpdate({
        target: journeySpecs.journeyId,
        set: {
          // biome-ignore lint/suspicious/noExplicitAny: validated JourneySpec → jsonb
          spec: spec as any,
          specSchemaVersion: spec.specVersion,
          version: sql`${journeySpecs.version} + 1`,
          updatedAt: new Date(),
        },
      })
      .returning();

    if (!row) throw new Error("Failed to upsert journey spec");
    // Make this API process's next ingest see the write immediately (the worker
    // picks it up on its TTL refresh).
    getRuntimeSpecStore().markStale();
    return c.json({ spec: summarize(row), created: !existing }, 200);
  })
  .openapi(patchRoute, async (c) => {
    const { db } = c.get("container");
    const { id } = c.req.valid("param");
    const { enabled } = c.req.valid("json");

    const [row] = await db
      .update(journeySpecs)
      .set({ enabled, updatedAt: new Date() })
      .where(eq(journeySpecs.journeyId, id))
      .returning();

    if (!row) return c.json({ error: "Spec not found" }, 404);
    getRuntimeSpecStore().markStale();
    return c.json({ spec: summarize(row) }, 200);
  })
  .openapi(deleteRoute, async (c) => {
    const { db } = c.get("container");
    const { id } = c.req.valid("param");

    const deleted = await db
      .delete(journeySpecs)
      .where(eq(journeySpecs.journeyId, id))
      .returning({ id: journeySpecs.journeyId });

    if (deleted.length === 0) return c.json({ error: "Spec not found" }, 404);
    getRuntimeSpecStore().markStale();
    return c.json({ deleted: true, id }, 200);
  });
