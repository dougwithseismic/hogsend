import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import {
  getReferralReport,
  getReferralTree,
  InvalidWindowError,
  parseWindowMs,
  REFERRAL_MODELS,
  REFERRAL_REPORT_MAX_DEPTH,
  resolveLevelWeights,
} from "../../lib/referral-report.js";
import { errorSchema } from "../../lib/schemas.js";
import {
  referralIdQuery,
  resolveNamedContactId,
  resolveReferralId,
} from "./shared.js";

/**
 * `GET /v1/referrals/report` and `GET /v1/referrals/tree/:contactId` (PRD 05
 * §5.3). Model, window, depth and level weights are REQUEST parameters, so
 * these two routes are the entire "reporting feature": nothing is persisted
 * per model and nothing is backfilled when the reader changes their mind.
 */

const DEFAULT_WINDOW = "30d";
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DEFAULT_TREE_DEPTH = 3;
const MAX_TREE_NODES = 1000;

const currencyValueSchema = z.object({
  currency: z.string(),
  value: z.number(),
});

const reportRoute = createRoute({
  method: "get",
  path: "/report",
  tags: ["Referrals"],
  summary: "Referral revenue and tree report",
  description:
    "Secret key + the `referrals` scope. Picks each referee's effective edge(s) under `model` within `window` (the touch-to-bind gap), walks the referrer chain to `depth`, and credits `weights[level] * edgeWeight * conversion value`. VALUES ARE NEVER CONVERTED BETWEEN CURRENCIES: every monetary field is a list of `{ currency, value }`.",
  request: {
    query: z.object({
      referral: referralIdQuery,
      model: z.enum(REFERRAL_MODELS).optional(),
      window: z.string().optional(),
      depth: z.coerce
        .number()
        .int()
        .min(1)
        .max(REFERRAL_REPORT_MAX_DEPTH)
        .optional(),
      weights: z.string().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
      cursor: z.string().optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            referral: z.string(),
            model: z.enum(REFERRAL_MODELS),
            window: z.string(),
            depth: z.number(),
            weights: z.array(z.number()),
            from: z.string().nullable(),
            to: z.string().nullable(),
            beneficiaries: z.array(
              z.object({
                contactId: z.string(),
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
              }),
            ),
            nextCursor: z.string().nullable(),
          }),
        },
      },
      description: "The report",
    },
    400: {
      content: { "application/json": { schema: errorSchema } },
      description: "Invalid window, weights, cursor or date",
    },
  },
});

const treeRoute = createRoute({
  method: "get",
  path: "/tree/{contactId}",
  tags: ["Referrals"],
  summary: "One referrer's descendants",
  description:
    "Secret key + the `referrals` scope. Walks DOWN from `contactId` to `depth` (default 3, cap 5) over every non-rejected edge. This is a ledger view, not a model: no window, no weights.",
  request: {
    params: z.object({ contactId: z.string().min(1) }),
    query: z.object({
      referral: referralIdQuery,
      depth: z.coerce
        .number()
        .int()
        .min(1)
        .max(REFERRAL_REPORT_MAX_DEPTH)
        .optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            referral: z.string(),
            contactId: z.string(),
            depth: z.number(),
            nodes: z.array(
              z.object({
                contactId: z.string(),
                level: z.number(),
                viaContactId: z.string(),
                status: z.string(),
                touchedAt: z.string(),
                boundAt: z.string().nullable(),
                qualifiedAt: z.string().nullable(),
                conversions: z.number(),
                value: z.array(currencyValueSchema),
              }),
            ),
          }),
        },
      },
      description: "The descendant nodes",
    },
    400: {
      content: { "application/json": { schema: errorSchema } },
      description: "Unresolvable contact key",
    },
  },
});

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

/** The cursor is an opaque decimal offset; a non-offset value is a 400. */
function parseCursor(input: string | undefined): number {
  if (!input) return 0;
  const offset = Number(input);
  if (!Number.isInteger(offset) || offset < 0) {
    throw new RangeError(`invalid cursor "${input}"`);
  }
  return offset;
}

function parseDate(input: string | undefined, label: string): Date | undefined {
  if (!input) return undefined;
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(`invalid ${label} date "${input}"`);
  }
  return date;
}

export function registerReferralReportRoute(router: OpenAPIHono<AppEnv>) {
  router.openapi(reportRoute, async (c) => {
    const { db } = c.get("container");
    const query = c.req.valid("query");

    const referralId = resolveReferralId(query.referral);
    const model = query.model ?? "first_touch";
    const windowInput = query.window ?? DEFAULT_WINDOW;
    const depth = query.depth ?? 1;
    const limit = query.limit ?? DEFAULT_LIMIT;

    let windowMs: number;
    let weights: number[];
    let offset: number;
    let from: Date | undefined;
    let to: Date | undefined;
    try {
      windowMs = parseWindowMs(windowInput);
      weights = parseWeights(query.weights, depth);
      offset = parseCursor(query.cursor);
      from = parseDate(query.from, "from");
      to = parseDate(query.to, "to");
    } catch (err) {
      if (err instanceof InvalidWindowError || err instanceof RangeError) {
        return c.json({ error: err.message }, 400);
      }
      throw err;
    }

    const levelWeights = resolveLevelWeights(depth, weights);
    const report = await getReferralReport({
      db,
      referralId,
      model,
      windowMs,
      depth,
      levelWeights,
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      limit,
      offset,
    });

    return c.json(
      {
        referral: referralId,
        model,
        window: windowInput,
        depth,
        weights: levelWeights,
        from: from ? from.toISOString() : null,
        to: to ? to.toISOString() : null,
        beneficiaries: report.beneficiaries,
        nextCursor:
          report.nextOffset === null ? null : String(report.nextOffset),
      },
      200,
    );
  });
}

export function registerReferralTreeRoute(router: OpenAPIHono<AppEnv>) {
  router.openapi(treeRoute, async (c) => {
    const { db } = c.get("container");
    const { contactId } = c.req.valid("param");
    const query = c.req.valid("query");
    const referralId = resolveReferralId(query.referral);
    const depth = query.depth ?? DEFAULT_TREE_DEPTH;

    // A tree is addressed by the CONTACT, so an external key resolves the same
    // way every other operator route resolves one. An unknown key is an empty
    // tree, not a 404: "this person referred nobody" is the same answer.
    const resolved = await resolveNamedContactId(db, contactId);
    if (!resolved) {
      return c.json({ referral: referralId, contactId, depth, nodes: [] }, 200);
    }

    const nodes = await getReferralTree({
      db,
      referralId,
      contactId: resolved,
      depth,
      limit: MAX_TREE_NODES,
    });

    return c.json(
      { referral: referralId, contactId: resolved, depth, nodes },
      200,
    );
  });
}
