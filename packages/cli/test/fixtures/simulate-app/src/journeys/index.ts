import {
  days,
  defineJourney,
  hours,
  sendEmail,
} from "@hogsend/engine/journeys";

// A tiny consumer app for the `hogsend simulate` end-to-end test. Its
// dependencies resolve from packages/cli/node_modules.

export const trialUpgrade = defineJourney({
  meta: {
    id: "trial-upgrade",
    name: "Trial upgrade",
    enabled: true,
    trigger: { event: "trial.started" },
    entryLimit: "once",
    suppress: hours(0),
    exitOn: [{ event: "subscription.created" }],
  },
  run: async (user, ctx) => {
    await sendEmail({
      to: user.email,
      userId: user.id,
      template: "trial-welcome" as never,
      subject: "Your trial has started",
    });
    const project = await ctx.waitForEvent({
      event: "project.created",
      timeout: days(2),
      label: "await-project",
    });
    if (project.timedOut) {
      await sendEmail({
        to: user.email,
        userId: user.id,
        template: "trial-nudge" as never,
        subject: "Create your first project",
      });
    }
    await ctx.sleep({ duration: days(5), label: "trial-ending" });
    await sendEmail({
      to: user.email,
      userId: user.id,
      template: "trial-ending" as never,
      subject: "Two days left",
      idempotencyLabel: "ending-reminder",
    });
    await ctx.sleep({ duration: days(2), label: "trial-over" });
    await ctx.trigger({ event: "trial.lapsed", userId: user.id });
  },
});

export const brokenWelcome = defineJourney({
  meta: {
    id: "broken-welcome",
    name: "Broken welcome",
    enabled: true,
    trigger: { event: "user.created" },
    entryLimit: "unlimited",
    suppress: hours(0),
  },
  run: async (_user, ctx) => {
    await ctx.sleep({ duration: hours(1), label: "settle" });
    throw new Error("template props missing: firstName");
  },
});

export const journeys = [trialUpgrade, brokenWelcome];
