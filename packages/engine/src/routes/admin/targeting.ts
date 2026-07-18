import { CANONICAL_STAGES, flagTargetingSchema } from "@hogsend/core";
import { campaigns, contacts } from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { desc, isNull, sql } from "drizzle-orm";
import type { AppEnv } from "../../app.js";
import {
  eventNameEntrySchema,
  listEventNameVocabulary,
} from "../../lib/event-names.js";
import { evaluateTargeting, loadTargetingSnapshot } from "../../lib/flags.js";

/**
 * Reusable targeting-builder catalog + a live match-count estimator. The
 * catalog is the raw material a Studio condition builder needs to compose EVERY
 * targeting leaf — the distinct contact-property keys and operator vocabulary
 * (property leaves) plus the id/name lists a builder picks from for the richer
 * snapshot leaves (buckets, journeys, deal stages) and the scan leaves (event
 * names) and campaigns. Named generically (`/targeting/catalog`, not
 * `/flags/catalog`) because the same vocabulary feeds any targeting UI.
 * `POST /targeting/count` estimates how many live contacts a targeting tree
 * matches, over a bounded sample. Both inherit the admin router's
 * `requireAdmin` guard.
 */

/** Cap on distinct property keys returned — a builder combobox, not an export. */
const MAX_PROPERTY_KEYS = 200;

/** Cap on event names returned in the catalog (observed + declared vocabulary). */
const MAX_EVENT_NAMES = 200;

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
 * Cap on contacts SAMPLED for a match-count estimate. Mirrors the catalog's
 * ~2000 most-recently-updated sampling so the estimate is bounded regardless of
 * table size — each sampled contact costs one targeting snapshot (a fixed set
 * of indexed queries), so this endpoint is O(sample), never O(all contacts).
 */
const MAX_COUNT_SAMPLE = 2000;

/**
 * How many sampled contacts to evaluate concurrently. Each evaluation loads a
 * snapshot (a few indexed queries) and, in server mode, may run scan leaves; a
 * small fixed fan-out bounds in-flight DB work instead of firing all
 * `MAX_COUNT_SAMPLE` at once.
 */
const COUNT_CONCURRENCY = 25;

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

/**
 * The deal-stage vocabulary a `deal` leaf's `stage` predicate picks from: the
 * deployment's canonical ladder plus the reserved terminal `"lost"`.
 */
const DEAL_STAGES: string[] = [...CANONICAL_STAGES, "lost"];

const idNameSchema = z.object({ id: z.string(), name: z.string() });

const catalogSchema = z.object({
  properties: z.array(z.string()),
  operators: z.array(
    z.object({
      value: z.string(),
      label: z.string(),
      unary: z.boolean(),
    }),
  ),
  buckets: z.array(idNameSchema),
  journeys: z.array(idNameSchema),
  dealStages: z.array(z.string()),
  events: z.array(eventNameEntrySchema),
  campaigns: z.array(idNameSchema),
});

const catalogRoute = createRoute({
  method: "get",
  path: "/catalog",
  tags: ["Admin — Targeting"],
  summary: "Targeting builder catalog (every leaf's vocabulary)",
  responses: {
    200: {
      content: { "application/json": { schema: catalogSchema } },
      description:
        "Property keys + operators, plus buckets, journeys, deal stages, event names, and campaigns",
    },
  },
});

const countBodySchema = z.object({
  /** One condition set's targeting tree (or the legacy bare property array). */
  targeting: flagTargetingSchema,
});

const countResponseSchema = z.object({
  /** Sampled contacts the tree matched. */
  matched: z.number(),
  /** Sampled contacts evaluated (≤ MAX_COUNT_SAMPLE, ≤ live contacts). */
  sampled: z.number(),
  /**
   * Honest estimate of matching LIVE contacts: `matched/sampled` scaled by the
   * live-contact count. Exact when the sample covers every live contact.
   */
  estimatedTotal: z.number(),
});

const countRoute = createRoute({
  method: "post",
  path: "/count",
  tags: ["Admin — Targeting"],
  summary: "Estimate how many live contacts a targeting tree matches",
  request: {
    body: {
      content: { "application/json": { schema: countBodySchema } },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: countResponseSchema } },
      description: "Sampled match count + scaled estimate",
    },
  },
});

export const targetingRouter = new OpenAPIHono<AppEnv>()
  .openapi(catalogRoute, async (c) => {
    const { db, registry, bucketRegistry } = c.get("container");

    // Distinct top-level property keys across a bounded SAMPLE of the most
    // recently-updated live contacts, sorted + capped. Sampling first (inner
    // limit) keeps `jsonb_object_keys` — which fans each contact's properties
    // object out to one row per key — from expanding the whole table on every
    // fetch. `coalesce` guards NULL/absent property maps. The property scan and
    // the event/campaign lookups are independent, so they go out together.
    const [propertyRows, events, campaignRows] = await Promise.all([
      db.execute<{ key: string }>(sql`
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
      `),
      listEventNameVocabulary({ db, registry, limit: MAX_EVENT_NAMES }),
      db
        .select({ id: campaigns.id, name: campaigns.name })
        .from(campaigns)
        .orderBy(desc(campaigns.createdAt))
        .limit(MAX_PROPERTY_KEYS),
    ]);

    const properties = Array.from(propertyRows, (r) => r.key);
    const buckets = bucketRegistry
      .getAll()
      .map((b) => ({ id: b.id, name: b.name }));
    const journeys = registry.getAll().map((j) => ({ id: j.id, name: j.name }));

    return c.json(
      {
        properties,
        operators: OPERATORS,
        buckets,
        journeys,
        dealStages: DEAL_STAGES,
        events: events.events,
        campaigns: campaignRows,
      },
      200,
    );
  })
  .openapi(countRoute, async (c) => {
    const { db } = c.get("container");
    const { targeting } = c.req.valid("json");

    // Bounded, most-recently-updated sample + the live-contact total for
    // scaling. `id` is the trusted uuid for property/deal reads; the logical
    // `contactKey` (external_id ?? anonymous_id ?? id) keys the
    // bucket/journey/event reads — the same identity split the flag readers use.
    const [sample, totalRows] = await Promise.all([
      db
        .select({
          id: contacts.id,
          externalId: contacts.externalId,
          anonymousId: contacts.anonymousId,
        })
        .from(contacts)
        .where(isNull(contacts.deletedAt))
        .orderBy(desc(contacts.updatedAt))
        .limit(MAX_COUNT_SAMPLE),
      db
        .select({ total: sql<number>`count(*)`.mapWith(Number) })
        .from(contacts)
        .where(isNull(contacts.deletedAt)),
    ]);

    const liveTotal = totalRows[0]?.total ?? 0;

    const evaluateOne = async (row: (typeof sample)[number]) => {
      const contactKey = row.externalId ?? row.anonymousId ?? row.id;
      const snapshot = await loadTargetingSnapshot({
        db,
        contactKey,
        contactId: row.id,
      });
      // Server mode so bucket/journey/deal AND the scan leaves
      // (event/email_engagement) all resolve for the estimate.
      return evaluateTargeting(targeting, {
        snapshot,
        mode: "server",
        db,
        userId: contactKey,
      });
    };

    // Bounded fan-out: evaluate in fixed-size chunks so at most
    // COUNT_CONCURRENCY snapshots are loading at once.
    let matched = 0;
    for (let i = 0; i < sample.length; i += COUNT_CONCURRENCY) {
      const chunk = sample.slice(i, i + COUNT_CONCURRENCY);
      const results = await Promise.all(chunk.map(evaluateOne));
      for (const hit of results) if (hit) matched += 1;
    }

    const sampled = sample.length;
    const estimatedTotal =
      sampled === 0 ? 0 : Math.round((matched / sampled) * liveTotal);

    return c.json({ matched, sampled, estimatedTotal }, 200);
  });
