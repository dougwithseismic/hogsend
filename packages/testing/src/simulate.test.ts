import {
  days,
  defineJourney,
  hours,
  sendConnectorAction,
  sendEmail,
  sendFeedItem,
  sendSms,
} from "@hogsend/engine/journeys";
import { describe, expect, it } from "vitest";
import { createJourneyTest, simulateJourney } from "./index.js";
import type { JourneyScenario, SimulationStep } from "./types.js";

const user = { id: "u1", email: "ada@example.com", properties: {} };
const start = "2026-03-02T09:00:00.000Z";

const onboarding = defineJourney({
  meta: {
    id: "sim-onboarding",
    name: "Simulated onboarding",
    enabled: true,
    trigger: { event: "user.created" },
    entryLimit: "once",
    suppress: hours(0),
    exitOn: [{ event: "subscription.created" }],
  },
  run: async (current, ctx) => {
    const arm = await ctx.variant("welcome-subject", ["short", "long"]);
    await sendEmail({
      to: current.email,
      userId: current.id,
      template: "welcome" as never,
      subject: arm === "short" ? "Welcome" : "Welcome to the product",
    });
    await ctx.checkpoint("welcomed");
    const project = await ctx.waitForEvent({
      event: "project.created",
      timeout: days(2),
      label: "await-project",
    });
    if (project.timedOut) {
      await sendEmail({
        to: current.email,
        userId: current.id,
        template: "nudge" as never,
      });
    }
    await ctx.sleep({ duration: days(3), label: "cool-off" });
    await sendEmail({
      to: current.email,
      userId: current.id,
      template: "tips" as never,
      idempotencyLabel: "tips-final",
    });
    await ctx.trigger({ event: "onboarding.finished", userId: current.id });
  },
});

const scenario = (
  overrides: Partial<JourneyScenario> = {},
): JourneyScenario => ({
  name: "default",
  user,
  now: start,
  ...overrides,
});

const kinds = (steps: SimulationStep[]) => steps.map((step) => step.kind);

describe("simulateJourney", () => {
  it("reports an ordered timeline for a completed run", async () => {
    const report = await simulateJourney(
      onboarding,
      scenario({
        events: [{ after: days(1), event: "project.created", properties: {} }],
      }),
    );

    expect(report.status).toBe("completed");
    expect(report.entry).toEqual({ allowed: true });
    expect(report.journey).toEqual({
      id: "sim-onboarding",
      name: "Simulated onboarding",
      trigger: "user.created",
      exitOn: ["subscription.created"],
    });
    expect(kinds(report.steps)).toEqual([
      "enrolled",
      "variant",
      "send",
      "checkpoint",
      "wait",
      "event",
      "wait",
      "send",
      "trigger",
      "completed",
    ]);
    expect(report.steps[4]).toEqual({
      kind: "wait",
      at: start,
      wait: "waitForEvent",
      label: "await-project",
      durationMs: 2 * 24 * 60 * 60 * 1000,
      event: "project.created",
      outcome: "matched",
      resumedAt: "2026-03-03T09:00:00.000Z",
      source: "forward",
    });
    expect(report.steps[6]).toMatchObject({
      wait: "sleep",
      label: "cool-off",
      durationMs: 3 * 24 * 60 * 60 * 1000,
      outcome: "resumed",
      resumedAt: "2026-03-06T09:00:00.000Z",
    });
    expect(report.steps[7]).toEqual({
      kind: "send",
      at: "2026-03-06T09:00:00.000Z",
      channel: "email",
      status: "sent",
      template: "tips",
      to: "ada@example.com",
      category: "journey",
      idempotencyLabel: "tips-final",
    });
    expect(report.steps[2]).not.toHaveProperty("idempotencyLabel");
    expect(report.summary).toEqual({
      sent: { email: 2, sms: 0, feed: 0, connector: 0 },
      blocked: 0,
      triggers: 1,
      waits: 2,
    });
    expect(report.virtualDurationMs).toBe(4 * 24 * 60 * 60 * 1000);
    expect(report.endedAt).toBe("2026-03-06T09:00:00.000Z");
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it("reports a timed-out wait and the branch it takes", async () => {
    const report = await simulateJourney(onboarding, scenario());
    const wait = report.steps.find(
      (step) => step.kind === "wait" && step.wait === "waitForEvent",
    );
    expect(wait).toMatchObject({ outcome: "timedOut" });
    expect(
      report.steps.filter((step) => step.kind === "send").map((step) => step),
    ).toEqual([
      expect.objectContaining({ template: "welcome" }),
      expect.objectContaining({
        template: "nudge",
        at: "2026-03-04T09:00:00.000Z",
      }),
      expect.objectContaining({ template: "tips" }),
    ]);
  });

  it("reports an exitOn exit, the interrupted wait, and unreached events", async () => {
    const report = await simulateJourney(
      onboarding,
      scenario({
        events: [
          { after: days(1), event: "project.created" },
          { after: days(3), event: "subscription.created" },
          { after: days(10), event: "feature.used" },
        ],
      }),
    );

    expect(report.status).toBe("exited");
    expect(report.exit).toEqual({
      source: "exitOn",
      reason: "subscription.created",
    });
    expect(report.steps.at(-1)).toEqual({
      kind: "exit",
      at: "2026-03-05T09:00:00.000Z",
      source: "exitOn",
      reason: "subscription.created",
    });
    expect(report.steps).toContainEqual(
      expect.objectContaining({
        kind: "wait",
        label: "cool-off",
        outcome: "exited",
      }),
    );
    expect(report.notReached).toEqual([
      { at: "2026-03-12T09:00:00.000Z", event: "feature.used" },
    ]);
  });

  it("skips a user the enrollment guards refuse, unless forced", async () => {
    const history = {
      journeys: [
        {
          userId: user.id,
          journeyId: "sim-onboarding",
          completedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    const skipped = await simulateJourney(onboarding, scenario({ history }));
    expect(skipped).toMatchObject({
      status: "skipped",
      entry: { allowed: false, reason: "already_entered_once" },
      virtualDurationMs: 0,
      steps: [{ kind: "skipped", at: start, reason: "already_entered_once" }],
    });

    const forced = await simulateJourney(onboarding, scenario({ history }), {
      force: true,
    });
    expect(forced.status).toBe("completed");
    expect(forced.entry).toEqual({
      allowed: false,
      reason: "already_entered_once",
      forced: true,
    });
  });

  it("reports a thrown journey as failed with the error", async () => {
    const broken = defineJourney({
      meta: { ...onboarding.meta, id: "sim-broken", exitOn: [] },
      run: async (_current, ctx) => {
        await ctx.sleep({ duration: hours(6), label: "before-crash" });
        throw new Error("template props missing: plan");
      },
    });
    const report = await simulateJourney(broken, scenario());

    expect(report.status).toBe("failed");
    expect(report.error).toMatchObject({
      name: "Error",
      message: "template props missing: plan",
    });
    expect(report.steps.at(-1)).toEqual({
      kind: "failed",
      at: "2026-03-02T15:00:00.000Z",
      error: "template props missing: plan",
    });
  });

  it("applies scheduled guard changes and reports blocked sends", async () => {
    const report = await simulateJourney(
      onboarding,
      scenario({ guard: [{ after: days(1), subscribed: false }] }),
    );

    expect(report.steps).toContainEqual({
      kind: "guard",
      at: "2026-03-03T09:00:00.000Z",
      subscribed: false,
    });
    expect(report.steps).toContainEqual(
      expect.objectContaining({
        kind: "send",
        template: "nudge",
        status: "unsubscribed",
        reason: "unsubscribed",
      }),
    );
    expect(report.summary.blocked).toBe(2);
    expect(report.summary.sent.email).toBe(1);
  });

  it("omits history fixtures from the timeline but lets the journey read them", async () => {
    let seen = false;
    const reader = defineJourney({
      meta: { ...onboarding.meta, id: "sim-history", entryLimit: "unlimited" },
      run: async (current, ctx) => {
        seen = (
          await ctx.history.hasEvent({
            userId: current.id,
            event: "feature.used",
          })
        ).found;
      },
    });
    const report = await simulateJourney(
      reader,
      scenario({
        history: {
          events: [
            {
              event: "feature.used",
              properties: {},
              userId: user.id,
              occurredAt: "2026-02-01T00:00:00.000Z",
            },
          ],
        },
      }),
    );

    expect(seen).toBe(true);
    expect(kinds(report.steps)).toEqual(["enrolled", "completed"]);
  });

  it("throws on invalid scenario input instead of reporting a journey failure", async () => {
    await expect(
      simulateJourney(onboarding, scenario({ now: "not-a-date" })),
    ).rejects.toThrow("invalid date");
    await expect(
      simulateJourney(
        onboarding,
        scenario({
          guard: [{ subscribed: false, after: days(1), at: start }],
        }),
      ),
    ).rejects.toThrow('either "at" or "after"');
  });
});

describe("harness timeline detail", () => {
  it("records sleepUntil targets, variant arms, and labels on every channel", async () => {
    const journey = defineJourney({
      meta: {
        id: "timeline-detail",
        name: "Timeline detail",
        enabled: true,
        trigger: { event: "detail.started" },
        entryLimit: "unlimited",
        suppress: hours(0),
      },
      run: async (current, ctx) => {
        await ctx.variant("arm", ["only"]);
        await ctx.sleepUntil("2026-03-03T08:00:00.000Z", { label: "morning" });
        await sendSms({
          to: "+15551234567",
          userId: current.id,
          template: "sms-hello" as never,
          idempotencyLabel: "sms-site",
        });
        await sendFeedItem({
          recipient: { userId: current.id },
          type: "announcement",
          idempotencyLabel: "feed-site",
        });
        await sendConnectorAction({
          connectorId: "discord",
          action: "sendMessage",
          idempotencyLabel: "discord-site",
        });
        await sendEmail({
          to: current.email,
          userId: current.id,
          template: "implicit" as never,
        });
      },
    });
    const test = createJourneyTest(journey, {
      user,
      now: start,
      smsConsent: "granted",
      connectorActions: [{ connectorId: "discord", name: "sendMessage" }],
    });
    await test.run();

    expect(test.timeline).toContainEqual({
      type: "variant",
      at: start,
      key: "arm",
      arm: "only",
    });
    expect(test.effects.waits[0]).toMatchObject({
      type: "sleepUntil",
      label: "morning",
      until: "2026-03-03T08:00:00.000Z",
      durationMs: 23 * 60 * 60 * 1000,
    });
    const labelOf = (type: string) =>
      test.timeline.find((entry) => entry.type === type)?.idempotencyLabel;
    expect(labelOf("sms")).toBe("sms-site");
    expect(labelOf("feed")).toBe("feed-site");
    expect(labelOf("connector")).toBe("discord-site");
    // The implicit site is the nearest wait label, not an authored label.
    expect(labelOf("email")).toBeUndefined();
  });
});
