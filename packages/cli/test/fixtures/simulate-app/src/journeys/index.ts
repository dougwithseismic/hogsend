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

// Never finishes on virtual time: simulate must stop it at the horizon.
export const weeklyLoop = defineJourney({
  meta: {
    id: "weekly-loop",
    name: "Weekly loop",
    enabled: true,
    trigger: { event: "digest.subscribed" },
    entryLimit: "unlimited",
    suppress: hours(0),
  },
  run: async (user, ctx) => {
    for (let week = 1; ; week += 1) {
      await ctx.sleep({ duration: days(7), label: `week-${week}` });
      await sendEmail({
        to: user.email,
        userId: user.id,
        template: "weekly-digest" as never,
        subject: `Week ${week}`,
      });
    }
  },
});

// Reports what the simulation child can see of the parent's environment.
export const envProbe = defineJourney({
  meta: {
    id: "env-probe",
    name: "Env probe",
    enabled: true,
    trigger: { event: "probe.started" },
    entryLimit: "unlimited",
    suppress: hours(0),
  },
  run: async (user) => {
    const env = process.env;
    const db = env.DATABASE_URL ? new URL(env.DATABASE_URL).hostname : "unset";
    await sendEmail({
      to: user.email,
      userId: user.id,
      template: "probe" as never,
      subject: [
        `posthog=${env.POSTHOG_API_KEY ?? "unset"}`,
        `resend=${env.RESEND_API_KEY ?? "unset"}`,
        `twilio=${env.TWILIO_AUTH_TOKEN ?? "unset"}`,
        `db=${db}`,
      ].join(" "),
    });
  },
});

// Spins without ever awaiting a ctx wait: only the wall-clock limit stops it.
export const spin = defineJourney({
  meta: {
    id: "spin",
    name: "Spin",
    enabled: true,
    trigger: { event: "spin.started" },
    entryLimit: "unlimited",
    suppress: hours(0),
  },
  run: async (_user, ctx) => {
    for (;;) await ctx.now();
  },
});

export const journeys = [
  trialUpgrade,
  brokenWelcome,
  weeklyLoop,
  envProbe,
  spin,
];
