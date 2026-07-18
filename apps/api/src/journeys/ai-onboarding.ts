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
    // D7: shares the user.created trigger — marginal lift (see
    // activation-welcome). The ctx.once plan call is already replay-safe;
    // the run body is untouched.
    holdout: { percent: 10 },
    goal: "revenue",
    version: "2026-07-baseline",
  },

  run: async (user, ctx) => {
    // Ask the AI to draft a personalised onboarding plan. Recorded once per
    // enrollment via `ctx.once`: the template key here is fixed (so the send key
    // is already replay-stable), but recording the plan keeps the email CONTENT
    // identical across a replay and avoids a second paid LLM call. Durable on any
    // engine.
    const plan = await ctx.once("onboarding-plan", async () => {
      const context = await getUserContext(ctx, user);
      return draftOnboardingPlan(context);
    });

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
