import { type DefinedReferral, durationToMs } from "@hogsend/core";
import type { Database } from "@hogsend/db";
import { contacts, links, referralTouches, trackedLinks } from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { AppEnv } from "../../app.js";
import { canonicalTrackedRowFilter, vanityUrlFor } from "../../lib/links.js";
import {
  getReferralOverview,
  getReferralReport,
  getReferralTree,
  InvalidWindowError,
  parseWindowMs,
  REFERRAL_MODELS,
  REFERRAL_REPORT_MAX_DEPTH,
  resolveLevelWeights,
} from "../../lib/referral-report.js";
import { resolveNamedContactId } from "../referrals/shared.js";

/**
 * Read-only admin surface over the referral ledger - the two endpoints the
 * Studio OBSERVE views consume. It adds no reporting semantics of its own: the
 * leaderboard is `getReferralReport()` and the drill-in is `getReferralTree()`,
 * the same functions `/v1/referrals/report` and `/v1/referrals/tree/:id` call,
 * so an operator and an API caller can never read two different numbers.
 *
 * What it DOES add is contact identity (email / external id), which the data
 * plane deliberately omits: `/v1/referrals/*` answers in contact ids because it
 * is machine-facing, while a leaderboard a human reads needs a name. The
 * router inherits `requireAdmin` from the admin router, so it never re-auths.
 *
 * Model, depth, window and weights stay REQUEST parameters here too (PRD 05
 * §5.3). The Studio picker just re-queries; nothing is persisted per model.
 */

const DEFAULT_WINDOW = "30d";
const DEFAULT_TREE_DEPTH = 3;
const MAX_TREE_NODES = 1000;

const currencyValueSchema = z.object({
  currency: z.string(),
  value: z.number(),
});

const contactSchema = z.object({
  id: z.string(),
  email: z.string().nullable(),
  externalId: z.string().nullable(),
});

const errorSchema = z.object({ error: z.string() });

const beneficiarySchema = z.object({
  contactId: z.string(),
  contact: contactSchema.nullable(),
  direct: z.object({
    touched: z.number(),
    bound: z.number(),
    qualified: z.number(),
  }),
  tree: z.array(
    z.object({
      level: z.number(),
      referees: z.number(),
      conversions: z.number(),
      value: z.array(currencyValueSchema),
    }),
  ),
  value: z.array(currencyValueSchema),
});

const treeNodeSchema = z.object({
  contactId: z.string(),
  contact: contactSchema.nullable(),
  level: z.number(),
  viaContactId: z.string(),
  status: z.string(),
  touchedAt: z.string(),
  boundAt: z.string().nullable(),
  qualifiedAt: z.string().nullable(),
  conversions: z.number(),
  value: z.array(currencyValueSchema),
});

const touchSchema = z.object({
  id: z.string(),
  referralId: z.string(),
  refereeKey: z.string(),
  refereeContactId: z.string().nullable(),
  referee: contactSchema.nullable(),
  source: z.string(),
  status: z.string(),
  rejectedReason: z.string().nullable(),
  touchedAt: z.string(),
  boundAt: z.string().nullable(),
  qualifiedAt: z.string().nullable(),
  linkId: z.string().nullable(),
});

const definitionSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  description: z.string().nullable(),
  /** The qualify event, or null when bind IS qualify. */
  qualifyEvent: z.string().nullable(),
  qualifyHasConditions: z.boolean(),
  bindWindowMs: z.number(),
  /** A fixed destination URL, or null when it is computed per referrer. */
  destination: z.string().nullable(),
  campaign: z.string().nullable(),
  hooks: z.array(z.string()),
});

const currencyValueList = z.array(currencyValueSchema);

const overviewSchema = z.object({
  referral: z.string(),
  referrals: z.array(z.string()),
  /** Null when the ledger holds a referral id no longer authored in code. */
  definition: definitionSchema.nullable(),
  from: z.string().nullable(),
  to: z.string().nullable(),
  referrers: z.number(),
  links: z.number(),
  funnel: z.object({
    touched: z.number(),
    bound: z.number(),
    qualified: z.number(),
    converted: z.number(),
  }),
  rejected: z.object({
    total: z.number(),
    byReason: z.array(z.object({ reason: z.string(), count: z.number() })),
  }),
  sources: z.array(z.object({ source: z.string(), count: z.number() })),
  refereeValue: currencyValueList,
  granularity: z.enum(["day", "week"]),
  series: z.array(
    z.object({
      date: z.string(),
      touched: z.number(),
      bound: z.number(),
      qualified: z.number(),
    }),
  ),
});

const referrerLinkSchema = z.object({
  id: z.string(),
  slug: z.string().nullable(),
  vanityUrl: z.string().nullable(),
  url: z.string(),
  originalUrl: z.string(),
  campaign: z.string().nullable(),
  clickCount: z.number(),
  createdAt: z.string(),
});

/** What of a `defineReferral` an operator can read back. No functions cross. */
function serializeDefinition(
  def: DefinedReferral,
): z.infer<typeof definitionSchema> {
  const hooks = (
    ["beforeTouch", "beforeBind", "beforeQualify"] as const
  ).filter((h) => typeof def.meta[h] === "function");
  return {
    id: def.id,
    name: def.meta.name ?? null,
    description: def.meta.description ?? null,
    qualifyEvent: def.meta.qualify?.event ?? null,
    qualifyHasConditions: (def.qualifyWhere?.length ?? 0) > 0,
    bindWindowMs: durationToMs(def.bindWindow),
    destination:
      typeof def.meta.link.destination === "string"
        ? def.meta.link.destination
        : null,
    campaign: def.meta.link.campaign ?? null,
    hooks,
  };
}

/** `"1,0.5,0.25"` -> `[1, 0.5, 0.25]`. Throws on anything else. */
function parseWeights(input: string | undefined, depth: number): number[] {
  if (!input) return [];
  const parts = input.split(",").map((p) => p.trim());
  if (parts.length > depth) {
    throw new RangeError(
      `weights has ${parts.length} entries but depth is ${depth}`,
    );
  }
  return parts.map((part) => {
    const value = Number(part);
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`weight "${part}" is not a non-negative number`);
    }
    return value;
  });
}

function parseDate(input: string | undefined, label: string): Date | undefined {
  if (!input) return undefined;
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(`invalid ${label} date "${input}"`);
  }
  return date;
}

/** Identity for a set of contact ids, so a leaderboard can show a name. */
async function contactsById(
  db: Database,
  ids: string[],
): Promise<Map<string, z.infer<typeof contactSchema>>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({
      id: contacts.id,
      email: contacts.email,
      externalId: contacts.externalId,
    })
    .from(contacts)
    .where(inArray(contacts.id, unique));
  return new Map(rows.map((r) => [r.id, r]));
}

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin — Referrals"],
  summary: "Referral leaderboard",
  request: {
    query: z.object({
      referral: z.string().min(1).optional(),
      model: z.enum(REFERRAL_MODELS).default("first_touch"),
      window: z.string().default(DEFAULT_WINDOW),
      depth: z.coerce
        .number()
        .int()
        .min(1)
        .max(REFERRAL_REPORT_MAX_DEPTH)
        .default(1),
      weights: z.string().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            referral: z.string(),
            referrals: z.array(z.string()),
            model: z.enum(REFERRAL_MODELS),
            window: z.string(),
            depth: z.number(),
            weights: z.array(z.number()),
            beneficiaries: z.array(beneficiarySchema),
            limit: z.number(),
            offset: z.number(),
            nextOffset: z.number().nullable(),
          }),
        },
      },
      description:
        "Referrers ranked by tree value under the requested model, with the registered referral ids for the picker",
    },
    400: {
      content: { "application/json": { schema: errorSchema } },
      description: "Invalid window, weights or date",
    },
  },
});

const overviewRoute = createRoute({
  method: "get",
  path: "/overview",
  tags: ["Admin — Referrals"],
  summary: "Program overview: definition, funnel, sources, rejections, series",
  request: {
    query: z.object({
      referral: z.string().min(1).optional(),
      from: z.string().optional(),
      to: z.string().optional(),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: overviewSchema } },
      description:
        "Ledger counts for one referral over the period; the same from/to the leaderboard takes",
    },
    400: {
      content: { "application/json": { schema: errorSchema } },
      description: "Invalid date",
    },
  },
});

const detailRoute = createRoute({
  method: "get",
  path: "/{contactId}",
  tags: ["Admin — Referrals"],
  summary: "One referrer's tree and touch log",
  request: {
    params: z.object({ contactId: z.string().min(1) }),
    query: z.object({
      referral: z.string().min(1).optional(),
      depth: z.coerce
        .number()
        .int()
        .min(1)
        .max(REFERRAL_REPORT_MAX_DEPTH)
        .default(DEFAULT_TREE_DEPTH),
      limit: z.coerce.number().int().min(1).max(200).default(100),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            referral: z.string(),
            referrals: z.array(z.string()),
            contactId: z.string(),
            contact: contactSchema.nullable(),
            depth: z.number(),
            links: z.array(referrerLinkSchema),
            nodes: z.array(treeNodeSchema),
            touches: z.array(touchSchema),
          }),
        },
      },
      description:
        "The descendants of this referrer plus their own touch log, including rejected touches and the reason",
    },
  },
});

export const adminReferralsRouter = new OpenAPIHono<AppEnv>()
  .openapi(listRoute, async (c) => {
    const { db, referrals } = c.get("container");
    const query = c.req.valid("query");
    // The registry lists the AUTHORED programs; the ledger may still hold rows
    // for one that was deleted from code, so the picker's default is whatever
    // the caller asked for, then the first registered id, then "default".
    const registered = referrals.ids();
    const referralId = query.referral ?? registered[0] ?? "default";

    let windowMs: number;
    let weights: number[];
    let from: Date | undefined;
    let to: Date | undefined;
    try {
      windowMs = parseWindowMs(query.window);
      weights = parseWeights(query.weights, query.depth);
      from = parseDate(query.from, "from");
      to = parseDate(query.to, "to");
    } catch (err) {
      if (err instanceof InvalidWindowError || err instanceof RangeError) {
        return c.json({ error: err.message }, 400);
      }
      throw err;
    }

    const levelWeights = resolveLevelWeights(query.depth, weights);
    const report = await getReferralReport({
      db,
      referralId,
      model: query.model,
      windowMs,
      depth: query.depth,
      levelWeights,
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      limit: query.limit,
      offset: query.offset,
    });

    const identity = await contactsById(
      db,
      report.beneficiaries.map((b) => b.contactId),
    );

    return c.json(
      {
        referral: referralId,
        referrals: registered,
        model: query.model,
        window: query.window,
        depth: query.depth,
        weights: levelWeights,
        beneficiaries: report.beneficiaries.map((b) => ({
          ...b,
          contact: identity.get(b.contactId) ?? null,
        })),
        limit: query.limit,
        offset: query.offset,
        nextOffset: report.nextOffset,
      },
      200,
    );
  })
  .openapi(overviewRoute, async (c) => {
    const { db, referrals } = c.get("container");
    const query = c.req.valid("query");
    const registered = referrals.ids();
    const referralId = query.referral ?? registered[0] ?? "default";
    let from: Date | undefined;
    let to: Date | undefined;
    try {
      from = parseDate(query.from, "from");
      to = parseDate(query.to, "to");
    } catch (err) {
      if (err instanceof RangeError) return c.json({ error: err.message }, 400);
      throw err;
    }
    const overview = await getReferralOverview({
      db,
      referralId,
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
    });
    const def = referrals.get(referralId);
    return c.json(
      {
        referral: referralId,
        referrals: registered,
        definition: def ? serializeDefinition(def) : null,
        from: from ? from.toISOString() : null,
        to: to ? to.toISOString() : null,
        ...overview,
      },
      200,
    );
  })
  .openapi(detailRoute, async (c) => {
    const { db, env, referrals } = c.get("container");
    const { contactId } = c.req.valid("param");
    const query = c.req.valid("query");
    const registered = referrals.ids();
    const referralId = query.referral ?? registered[0] ?? "default";

    // Studio addresses a referrer by contact id, but an operator pasting an
    // external key must not 500 on a failed uuid cast. An unknown key is an
    // empty tree, matching `/v1/referrals/tree/:contactId`.
    const resolved = await resolveNamedContactId(db, contactId);
    if (!resolved) {
      return c.json(
        {
          referral: referralId,
          referrals: registered,
          contactId,
          contact: null,
          depth: query.depth,
          links: [],
          nodes: [],
          touches: [],
        },
        200,
      );
    }

    const [nodes, touchRows, linkRows] = await Promise.all([
      getReferralTree({
        db,
        referralId,
        contactId: resolved,
        depth: query.depth,
        limit: MAX_TREE_NODES,
      }),
      db
        .select()
        .from(referralTouches)
        .where(
          and(
            eq(referralTouches.referralId, referralId),
            eq(referralTouches.referrerContactId, resolved),
          ),
        )
        .orderBy(desc(referralTouches.touchedAt))
        .limit(query.limit),
      // The referrer's own share links: what they were given to send around.
      db
        .select({
          id: links.id,
          slug: links.slug,
          originalUrl: links.originalUrl,
          campaign: links.campaign,
          createdAt: links.createdAt,
          trackedLinkId: sql<
            string | null
          >`min(${trackedLinks.id}::text) filter (where ${canonicalTrackedRowFilter()})`,
          clickCount:
            sql<number>`coalesce(sum(${trackedLinks.clickCount}), 0)`.mapWith(
              Number,
            ),
        })
        .from(links)
        .leftJoin(trackedLinks, eq(trackedLinks.linkId, links.id))
        .where(
          and(
            eq(links.referralId, referralId),
            eq(links.ownerContactId, resolved),
            isNull(links.archivedAt),
          ),
        )
        .groupBy(links.id)
        .orderBy(desc(links.createdAt)),
    ]);

    // One identity lookup covers the referrer, every tree node and every
    // touch's referee.
    const identity = await contactsById(db, [
      resolved,
      ...nodes.map((n) => n.contactId),
      ...touchRows.flatMap((t) =>
        t.refereeContactId ? [t.refereeContactId] : [],
      ),
    ]);

    return c.json(
      {
        referral: referralId,
        referrals: registered,
        contactId: resolved,
        contact: identity.get(resolved) ?? null,
        depth: query.depth,
        links: linkRows.map((l) => ({
          id: l.id,
          slug: l.slug,
          vanityUrl: l.slug ? vanityUrlFor(env.API_PUBLIC_URL, l.slug) : null,
          url: `${env.API_PUBLIC_URL}/v1/t/c/${l.trackedLinkId ?? ""}`,
          originalUrl: l.originalUrl,
          campaign: l.campaign,
          clickCount: l.clickCount,
          createdAt: l.createdAt.toISOString(),
        })),
        nodes: nodes.map((n) => ({
          ...n,
          contact: identity.get(n.contactId) ?? null,
        })),
        touches: touchRows.map((t) => ({
          id: t.id,
          referralId: t.referralId,
          refereeKey: t.refereeKey,
          refereeContactId: t.refereeContactId,
          referee: t.refereeContactId
            ? (identity.get(t.refereeContactId) ?? null)
            : null,
          source: t.source,
          status: t.status,
          rejectedReason: t.rejectedReason,
          touchedAt: t.touchedAt.toISOString(),
          boundAt: t.boundAt ? t.boundAt.toISOString() : null,
          qualifiedAt: t.qualifiedAt ? t.qualifiedAt.toISOString() : null,
          linkId: t.linkId,
        })),
      },
      200,
    );
  });
