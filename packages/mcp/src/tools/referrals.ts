/**
 * `get_referral_report` and `get_referral_tree`: the two READ-ONLY referral
 * tools. Both wrap the admin routes (`GET /v1/admin/referrals`,
 * `GET /v1/admin/referrals/{contactId}`), which reuse the same report functions
 * the `/v1/referrals` data plane calls, so an agent and an operator can never
 * read two different numbers.
 *
 * Model, depth, window and weights are REQUEST parameters (PRD 05 §5.3):
 * nothing is persisted per model, so an agent may re-ask under a different
 * model as often as it likes without changing any stored state.
 */
import { z } from "zod";
import type { AdminClient } from "../lib/admin-client.js";
import { mapHttpError } from "../lib/result.js";
import { defineTool, type McpTool } from "../lib/tool.js";

const REPORT_NAME = "get_referral_report";
const TREE_NAME = "get_referral_tree";

const MODELS = [
  "first_touch",
  "last_touch",
  "linear",
  "time_decay",
  "position",
] as const;

const reportShape = {
  referral: z
    .string()
    .min(1)
    .optional()
    .describe("The defineReferral id. Defaults to the first registered one."),
  model: z
    .enum(MODELS)
    .optional()
    .describe(
      "Which edge gets the credit when a referee was touched by more than one referrer. Default first_touch.",
    ),
  window: z
    .string()
    .optional()
    .describe(
      "Touch-to-bind gap ceiling as <number><unit> (ms, s, m, h, d, w). Default 30d.",
    ),
  depth: z
    .number()
    .int()
    .min(1)
    .max(5)
    .optional()
    .describe("How many levels of the referrer chain to walk. Default 1."),
  weights: z
    .string()
    .optional()
    .describe(
      'Comma-separated credit weight per level, index 0 = level 1 ("1,0.5,0.25"). Levels past the vector default to 0.',
    ),
  from: z
    .string()
    .optional()
    .describe("ISO date: only conversions at or after it count."),
  to: z
    .string()
    .optional()
    .describe("ISO date: only conversions at or before it count."),
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
} satisfies z.ZodRawShape;

const reportDescription =
  "Read-only referral leaderboard: who is referring, how many people they " +
  "touched/bound/qualified, and the revenue their tree produced under the " +
  "requested attribution model, window, depth and level weights. Every monetary " +
  "field is a list of { currency, value }: values are NEVER converted between " +
  "currencies, so do not add them together. Model/window/depth/weights are " +
  "request parameters only; nothing is stored or backfilled. Requires a " +
  "full-admin key.";

const treeShape = {
  contactId: z
    .string()
    .min(1)
    .describe("The referrer's contact id (or external key)."),
  referral: z
    .string()
    .min(1)
    .optional()
    .describe("The defineReferral id. Defaults to the first registered one."),
  depth: z
    .number()
    .int()
    .min(1)
    .max(5)
    .optional()
    .describe("How many levels down to walk. Default 3."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("Max touch-log rows returned. Default 100."),
} satisfies z.ZodRawShape;

const treeDescription =
  "Read-only drill-in for ONE referrer: their descendants to `depth` plus their " +
  "own touch log, rejected touches included with the reason (self, window, veto, " +
  "bot, duplicate). This is a ledger view, not a model: no window is applied and " +
  "nothing is weighted, so its numbers can differ from get_referral_report's " +
  "model-weighted value. An unknown contact returns an empty tree, not an error. " +
  "Requires a full-admin key.";

/** Build the `get_referral_report` tool bound to an {@link AdminClient}. */
export function createReferralReportTool(
  client: AdminClient,
): McpTool<typeof reportShape> {
  return defineTool({
    name: REPORT_NAME,
    description: reportDescription,
    inputSchema: reportShape,
    run: async (query) => {
      try {
        const res = await client.get<Record<string, unknown>>(
          "/v1/admin/referrals",
          query,
        );
        return { ok: true as const, ...res };
      } catch (err) {
        return mapHttpError(err);
      }
    },
  });
}

/** Build the `get_referral_tree` tool bound to an {@link AdminClient}. */
export function createReferralTreeTool(
  client: AdminClient,
): McpTool<typeof treeShape> {
  return defineTool({
    name: TREE_NAME,
    description: treeDescription,
    inputSchema: treeShape,
    run: async ({ contactId, ...query }) => {
      try {
        const res = await client.get<Record<string, unknown>>(
          `/v1/admin/referrals/${encodeURIComponent(contactId)}`,
          query,
        );
        return { ok: true as const, ...res };
      } catch (err) {
        return mapHttpError(err);
      }
    },
  });
}
