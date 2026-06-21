/**
 * Tier-2 AI agent: re-engagement strategist.
 *
 * Uses `generateText` with tool calls so the model can pull history signals
 * mid-reasoning before making a final typed decision. The journey acts on
 * the `decide` tool result — including choosing to stay silent (`suppress`).
 *
 * Pattern: agent pulls data with tools, then calls `decide` once with a
 * structured action. The journey reads `action` and either sends the matching
 * template or returns early without sending anything.
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import type { JourneyContext, JourneyUser } from "@hogsend/engine";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Decision schema
// ---------------------------------------------------------------------------

export const ReengagementAction = z.enum([
  "reengage_tip_a",
  "reengage_tip_b",
  "reengage_webinar",
  "suppress",
]);

export type ReengagementActionType = z.infer<typeof ReengagementAction>;

export const ReengagementDecision = z.object({
  /** Which action to take — or `suppress` to send nothing. */
  action: ReengagementAction,
  /** Brief explanation of why this action was chosen. */
  reason: z.string().describe("One sentence explaining the choice."),
});

export type ReengagementDecisionType = z.infer<typeof ReengagementDecision>;

// ---------------------------------------------------------------------------
// Agent function
// ---------------------------------------------------------------------------

/**
 * Decide the next best re-engagement action for a dormant user.
 *
 * Returns a typed decision `{ action, reason }`. The journey maps `action`
 * to the matching template, or returns early when `action === "suppress"`.
 *
 * @param user - The journey user being re-engaged.
 * @param ctx  - The journey context, used by tools to pull history signals.
 */
export async function decideNextBestAction(
  user: JourneyUser,
  ctx: JourneyContext,
): Promise<ReengagementDecisionType> {
  const anthropic = createAnthropic();

  let decision: ReengagementDecisionType | undefined;

  await generateText({
    model: anthropic("claude-opus-4-8"),
    stopWhen: stepCountIs(5),
    system: `You are a re-engagement strategist for Hogsend, a lifecycle email platform.
A user has been dormant for 30+ days. Your job is to decide the single best
next-touch — or to stay silent if the signals suggest the user is already
coming back or no touch is the right call.

Available actions:
- reengage_tip_a    — send a practical "quick win" tip email (best for users who engaged before but drifted)
- reengage_tip_b    — send an advanced-use-case email (best for power-users who haven't logged in)
- reengage_webinar  — invite to a live onboarding webinar (best for users who never fully onboarded)
- suppress          — do not send anything (best when the user shows signs of already returning, or none of the touches above fit)

Use the tools to check the user's feature usage and history before deciding.
Always call the \`decide\` tool exactly once to record your final answer.`,

    prompt: `User: ${user.email} (id: ${user.id})
Decide the best re-engagement action for this dormant user.`,

    tools: {
      /**
       * Check whether the user has ever used a specific feature event.
       */
      usedFeature: tool({
        description:
          "Check whether the user has fired a specific feature event in the past.",
        inputSchema: z.object({
          event: z
            .string()
            .describe(
              "The event name to look up (e.g. 'feature.activated', 'key.action').",
            ),
          withinDays: z
            .number()
            .optional()
            .describe(
              "If set, only count events within the last N days. Omit to check all time.",
            ),
        }),
        execute: async ({ event, withinDays }) => {
          const opts: Parameters<typeof ctx.history.hasEvent>[0] = {
            userId: user.id,
            event,
          };
          if (withinDays !== undefined) {
            // DurationObject uses hours — convert days to hours.
            opts.within = { hours: withinDays * 24 };
          }
          const { found, count } = await ctx.history.hasEvent(opts);
          return { found, count };
        },
      }),

      /**
       * Fetch recent raw events for richer reasoning.
       */
      recentEvents: tool({
        description: "Fetch the user's most recent events, newest first.",
        inputSchema: z.object({
          limit: z
            .number()
            .min(1)
            .max(20)
            .default(10)
            .describe("How many events to return (max 20)."),
        }),
        execute: async ({ limit }) => {
          const events = await ctx.history.events({ userId: user.id, limit });
          return { events };
        },
      }),

      /**
       * Record the final decision. Calling this ends the agent loop.
       */
      decide: tool({
        description:
          "Record the final re-engagement decision. Call this exactly once.",
        inputSchema: ReengagementDecision,
        execute: async (params) => {
          // First decision wins — ignore any accidental repeat calls so a
          // double-call inside the step budget can't overwrite the answer.
          if (decision === undefined) {
            decision = params;
          }
          return { recorded: true };
        },
      }),
    },
  });

  // The model must call `decide` at least once.
  if (decision === undefined) {
    // Fall back to suppress rather than crashing the journey.
    return { action: "suppress", reason: "Agent did not call decide tool." };
  }

  return decision;
}
