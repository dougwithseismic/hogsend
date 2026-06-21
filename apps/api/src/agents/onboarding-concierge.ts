/**
 * Tier-1 AI agent: onboarding concierge.
 *
 * Given a rich user-context bundle (contact properties, recent events,
 * email engagement, and optional PostHog person props), drafts a
 * personalised onboarding plan that the AI onboarding journey renders
 * into the user's first email.
 *
 * Uses `generateObject` from the Vercel AI SDK with an Anthropic model so
 * the output is validated by Zod at the boundary — no separate `.parse()`.
 * Import this directly from a journey; no factory wiring is required.
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import { z } from "zod";
import type { UserContext } from "../lib/user-context.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const OnboardingPlan = z.object({
  /** Short, personalised email subject line. */
  subject: z
    .string()
    .describe("A concise, personalised email subject line (max 60 chars)."),

  /** Opening paragraph tailored to this user's context. */
  body: z
    .string()
    .describe(
      "A friendly, 2–3 sentence opening paragraph personalised to the user's setup and goals.",
    ),

  /** Two or three concrete next-step tips for this user. */
  tips: z
    .array(z.string())
    .min(1)
    .max(3)
    .describe(
      "Ordered list of 1–3 short, actionable tips tailored to this user.",
    ),

  /**
   * The name of the first feature this user should activate.
   * Used by the day-3 nudge email if the user hasn't activated yet.
   */
  featureToActivate: z
    .string()
    .describe(
      "The single most important feature for this user to try first (short noun phrase).",
    ),
});

export type OnboardingPlanType = z.infer<typeof OnboardingPlan>;

// ---------------------------------------------------------------------------
// Agent function
// ---------------------------------------------------------------------------

/**
 * Draft a personalised onboarding plan for a new signup.
 *
 * @param context - The assembled user-context bundle from `getUserContext()`.
 * @returns A validated `OnboardingPlanType` object.
 */
export async function draftOnboardingPlan(
  context: UserContext,
): Promise<OnboardingPlanType> {
  const anthropic = createAnthropic();

  const recentEventNames = context.events
    .slice(0, 10)
    .map((e) => e.event)
    .join(", ");

  const posthogSummary = context.posthog
    ? JSON.stringify(context.posthog, null, 2)
    : "Not available";

  const prompt = `You are the onboarding concierge for Hogsend, a lifecycle email platform for developer teams using PostHog and Resend.

A new user has just signed up. Draft a personalised onboarding plan to welcome them and help them succeed.

User context:
- Email: ${context.contact.email}
- Contact properties: ${JSON.stringify(context.contact.properties)}
- Recent events (newest first): ${recentEventNames || "none yet"}
- Email engagement: opened=${context.email.everOpened}, clicked=${context.email.everClicked}
- PostHog person properties: ${posthogSummary}

Tailor your response to what you know about this user. Be concise, warm, and practical.
Focus on what will help them get their first journey live quickly.`;

  const { object } = await generateObject({
    model: anthropic("claude-haiku-4-5"),
    schema: OnboardingPlan,
    prompt,
  });

  return object;
}
