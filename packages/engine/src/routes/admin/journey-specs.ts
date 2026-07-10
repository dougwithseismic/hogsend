import { journeySpecs, journeySpecVersions } from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { ZodError } from "zod";
import type { AppEnv } from "../../app.js";
import { ejectSpecToCode } from "../../journeys/spec/eject-to-code.js";
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

const versionsRoute = createRoute({
  method: "get",
  path: "/{id}/versions",
  tags: ["Admin — Journey Specs"],
  summary: "List the version history of a stored journey spec",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            versions: z.array(
              z.object({ version: z.number(), createdAt: z.string() }),
            ),
          }),
        },
      },
      description: "All archived versions, newest first",
    },
  },
});

const rollbackRoute = createRoute({
  method: "post",
  path: "/{id}/rollback",
  tags: ["Admin — Journey Specs"],
  summary: "Roll a stored spec back to a prior version",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({ version: z.number().int().positive() }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ spec: specSummarySchema }),
        },
      },
      description:
        "Rolled forward: the target snapshot becomes the live spec at a new version",
    },
    400: {
      content: { "application/json": { schema: errorSchema } },
      description:
        "Target snapshot no longer validates (e.g. a template was removed)",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Spec or target version not found",
    },
  },
});

const ejectRoute = createRoute({
  method: "get",
  path: "/{id}/eject",
  tags: ["Admin — Journey Specs"],
  summary: "Promote a stored spec to equivalent defineJourney() TypeScript",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ filename: z.string(), code: z.string() }),
        },
      },
      description:
        "The generated .journey.ts source (the graduation path to code)",
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
    // Archive this version into the immutable history (Slice 3) so it can be
    // listed / diffed / rolled back to. Keyed (journeyId, version) — idempotent
    // on a retry of the same version.
    await db
      .insert(journeySpecVersions)
      .values({
        journeyId: id,
        version: row.version,
        // biome-ignore lint/suspicious/noExplicitAny: validated JourneySpec → jsonb
        spec: spec as any,
      })
      .onConflictDoNothing({
        target: [journeySpecVersions.journeyId, journeySpecVersions.version],
      });
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
  })
  .openapi(versionsRoute, async (c) => {
    const { db } = c.get("container");
    const { id } = c.req.valid("param");
    const rows = await db
      .select({
        version: journeySpecVersions.version,
        createdAt: journeySpecVersions.createdAt,
      })
      .from(journeySpecVersions)
      .where(eq(journeySpecVersions.journeyId, id))
      .orderBy(desc(journeySpecVersions.version));
    return c.json(
      {
        versions: rows.map((r) => ({
          version: r.version,
          createdAt: r.createdAt.toISOString(),
        })),
      },
      200,
    );
  })
  .openapi(rollbackRoute, async (c) => {
    const { db, templates } = c.get("container");
    const { id } = c.req.valid("param");
    const { version } = c.req.valid("json");

    // A live spec must exist to roll back (rollback re-points it forward).
    const [live] = await db
      .select({ version: journeySpecs.version })
      .from(journeySpecs)
      .where(eq(journeySpecs.journeyId, id))
      .limit(1);
    if (!live) return c.json({ error: "Spec not found" }, 404);

    const [target] = await db
      .select({ spec: journeySpecVersions.spec })
      .from(journeySpecVersions)
      .where(
        and(
          eq(journeySpecVersions.journeyId, id),
          eq(journeySpecVersions.version, version),
        ),
      )
      .limit(1);
    if (!target) return c.json({ error: `Version ${version} not found` }, 404);

    // Re-validate against the CURRENT registry — a template the old snapshot used
    // may have been removed since. Fail closed rather than restoring a dead ref.
    const templateKeys = new Set(Object.keys(templates ?? {}));
    let spec: ReturnType<typeof validateJourneySpec>;
    try {
      spec = validateJourneySpec(target.spec, { templateKeys });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json(
        { error: `Target version no longer validates: ${message}` },
        400,
      );
    }

    // Roll FORWARD (Conductor model): the target snapshot becomes the live spec
    // at a NEW version, so in-flight runs on other versions are undisturbed.
    const [row] = await db
      .update(journeySpecs)
      .set({
        // biome-ignore lint/suspicious/noExplicitAny: validated JourneySpec → jsonb
        spec: spec as any,
        specSchemaVersion: spec.specVersion,
        version: sql`${journeySpecs.version} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(journeySpecs.journeyId, id))
      .returning();
    if (!row) throw new Error("Failed to roll back journey spec");

    await db
      .insert(journeySpecVersions)
      .values({
        journeyId: id,
        version: row.version,
        // biome-ignore lint/suspicious/noExplicitAny: validated JourneySpec → jsonb
        spec: spec as any,
      })
      .onConflictDoNothing({
        target: [journeySpecVersions.journeyId, journeySpecVersions.version],
      });
    getRuntimeSpecStore().markStale();
    return c.json({ spec: summarize(row) }, 200);
  })
  .openapi(ejectRoute, async (c) => {
    const { db } = c.get("container");
    const { id } = c.req.valid("param");
    const [row] = await db
      .select({ spec: journeySpecs.spec })
      .from(journeySpecs)
      .where(eq(journeySpecs.journeyId, id))
      .limit(1);
    if (!row) return c.json({ error: "Spec not found" }, 404);

    // Parse defensively; a stored row is valid-at-write, but eject must never 500
    // on drift — surface it as a not-found-shaped error instead.
    let spec: ReturnType<typeof validateJourneySpec>;
    try {
      spec = validateJourneySpec(row.spec);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: `Spec no longer validates: ${message}` }, 404);
    }

    const code = ejectSpecToCode(spec);
    return c.json({ filename: `${spec.id}.journey.ts`, code }, 200);
  });
