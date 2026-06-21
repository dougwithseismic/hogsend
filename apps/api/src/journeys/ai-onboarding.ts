import { days, hours } from "@hogsend/core";
import { defineJourney, sendEmail } from "@hogsend/engine";
import { draftOnboardingPlan } from "../agents/onboarding-concierge.js";
import { getUserContext } from "../lib/user-context.js";
import { Events, Templates } from "./constants/index.js";

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
    // Build the rich user-context bundle consumed by the agent.
    const context = await getUserContext(ctx, user);

    // Ask the AI to draft a personalised onboarding plan.
    const plan = await draftOnboardingPlan(context);

    // Send the personalised welcome email immediately.
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

    // Wait 3 days before checking whether the user has activated.
    await ctx.sleep({ duration: days(3), label: "post-welcome-window" });

    // Only nudge if they haven't activated the key feature and are still subscribed.
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
