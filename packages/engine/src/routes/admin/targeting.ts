import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { sql } from "drizzle-orm";
import type { AppEnv } from "../../app.js";

/**
 * Reusable targeting-builder catalog: the raw material a Studio condition
 * builder needs to compose PROPERTY leaves — the distinct contact-property keys
 * plus the operator vocabulary (with human labels and a `unary` flag for the
 * value-less operators). Named generically (`/targeting/catalog`, not
 * `/flags/catalog`) because buckets/journeys will add more targeting sources
 * later. Inherits the admin router's `requireAdmin` guard.
 */

/** Cap on distinct property keys returned — a builder combobox, not an export. */
const MAX_PROPERTY_KEYS = 200;

/**
 * Cap on contacts SAMPLED for key discovery. The catalog only needs the shape
 * of the property vocabulary, not every key that ever existed, so we bound the
 * SCAN (not just the output): without this, `distinct` + `order by` must expand
 * every live contact's property object before `limit` can trim, i.e. a full
 * sequential scan on every fetch. Sampling the most-recently-updated slice
 * keeps the work bounded and the vocabulary current.
 */
const MAX_SAMPLED_CONTACTS = 2000;

/**
 * The 9 property operators (see `PropertyCondition`) with human labels. `unary`
 * operators (`exists`/`not_exists`) take no comparison value, so the builder
 * hides the value input for them.
 */
const OPERATORS: Array<{ value: string; label: string; unary: boolean }> = [
  { value: "eq", label: "equals", unary: false },
  { value: "neq", label: "does not equal", unary: false },
  { value: "gt", label: "greater than", unary: false },
  { value: "gte", label: "greater than or equal to", unary: false },
  { value: "lt", label: "less than", unary: false },
  { value: "lte", label: "less than or equal to", unary: false },
  { value: "contains", label: "contains", unary: false },
  { value: "exists", label: "is set", unary: true },
  { value: "not_exists", label: "is not set", unary: true },
];

const catalogSchema = z.object({
  properties: z.array(z.string()),
  operators: z.array(
    z.object({
      value: z.string(),
      label: z.string(),
      unary: z.boolean(),
    }),
  ),
});

const catalogRoute = createRoute({
  method: "get",
  path: "/catalog",
  tags: ["Admin — Targeting"],
  summary: "Targeting builder catalog (property keys + operators)",
  responses: {
    200: {
      content: { "application/json": { schema: catalogSchema } },
      description: "Property keys + operator vocabulary",
    },
  },
});

export const targetingRouter = new OpenAPIHono<AppEnv>().openapi(
  catalogRoute,
  async (c) => {
    const { db } = c.get("container");

    // Distinct top-level property keys across a bounded SAMPLE of the most
    // recently-updated live contacts, sorted + capped. Sampling first (inner
    // limit) keeps `jsonb_object_keys` — which fans each contact's properties
    // object out to one row per key — from expanding the whole table on every
    // fetch. `coalesce` guards NULL/absent property maps.
    const rows = await db.execute<{ key: string }>(sql`
      select distinct key
      from (
        select properties
        from contacts
        where deleted_at is null
        order by updated_at desc
        limit ${MAX_SAMPLED_CONTACTS}
      ) as sampled,
      jsonb_object_keys(coalesce(properties, '{}'::jsonb)) as key
      order by key
      limit ${MAX_PROPERTY_KEYS}
    `);

    const properties = Array.from(rows, (r) => r.key);

    return c.json({ properties, operators: OPERATORS }, 200);
  },
);
