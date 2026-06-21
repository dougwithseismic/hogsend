import { days, hours } from "@hogsend/core";
import { defineJourney, sendEmail } from "@hogsend/engine";
import { draftOnboardingPlan } from "../agents/onboarding-concierge.js";
import { getUserContext } from "../lib/user-context.js";
import { Events, Templates } from "./constants/index.js";

/**
 * Tier-1 AI onboarding journey.
 *
 * On every `user.created` event, this journey:
 * 1. Assembles a rich user-context bundle (recent events + email engagement
 *    + optional PostHog person props).
 * 2. Calls the onboarding-concierge agent to draft a personalised welcome plan.
 * 3. Sends the AI-personalised welcome email immediately.
 * 4. Sleeps 3 days, then nudges the user if they haven't activated yet.
 *
 * The agent (`src/agents/onboarding-concierge.ts`) uses `generateObject` with
 * `claude-haiku-4-5` so the output is validated by Zod before the send — a
 * malformed completion fails the Hatchet task (retried) before any email sends.
 *
 * Requires: ANTHROPIC_API_KEY in your env (see .env.example).
 */
export const aiOnboarding = defineJourney({
  meta: {
    id: "ai-onboarding",
    name: "AI Onboarding — Personalised Welcome",
    enabled: true,
    trigger: { event: Events.USER_CREATED },
    entryLimit: "once",
    suppress: hours(12),
    exitOn: [{ event: Events.USER_DELETED }],
  },

  run: async (user, ctx) => {
    // 1. Build the rich user-context bundle consumed by the agent.
    const context = await getUserContext(ctx, user);

    // 2. Ask the AI to draft a personalised onboarding plan.
    const plan = await draftOnboardingPlan(context);

    // 3. Send the personalised welcome email immediately.
    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.ONBOARDING_PERSONALIZED,
      subject: plan.subject,
      props: {
        name: user.email.split("@")[0] ?? "there",
        subject: plan.subject,
        body: plan.body,
        tips: plan.tips,
      },
      journeyName: user.journeyName,
    });

    // 4. Wait 3 days before checking whether the user has activated.
    await ctx.sleep({ duration: days(3), label: "post-welcome-window" });

    // Only nudge if they haven't activated the key feature and are subscribed.
    const { found: hasActivated } = await ctx.history.hasEvent({
      userId: user.id,
      event: Events.FEATURE_ACTIVATED,
    });

    const isStillSubscribed = await ctx.guard.isSubscribed();

    if (!hasActivated && isStillSubscribed) {
      await sendEmail({
        to: user.email,
        userId: user.id,
        journeyStateId: user.stateId,
        template: Templates.ONBOARDING_NUDGE,
        subject: `Still haven't tried ${plan.featureToActivate}?`,
        props: {
          name: user.email.split("@")[0] ?? "there",
          featureName: plan.featureToActivate,
        },
        journeyName: user.journeyName,
      });
    }
  },
});
