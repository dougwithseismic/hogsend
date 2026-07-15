import type { TemplateRegistry } from "@hogsend/email";
import {
  days,
  defineJourney,
  hours,
  sendConnectorAction,
  sendEmail,
  sendFeedItem,
  sendSms,
} from "@hogsend/engine/journeys";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { createJourneyTest, runJourneyScenarios } from "./index.js";
import "./vitest.js";

const user = { id: "u1", email: "dev@acme.com", properties: { plan: "trial" } };

const journey = defineJourney({
  meta: {
    id: "test-onboarding",
    name: "Test onboarding",
    enabled: true,
    trigger: { event: "user.created" },
    entryLimit: "once",
    suppress: hours(0),
    exitOn: [{ event: "user.deleted" }],
  },
  run: async (current, ctx) => {
    await sendEmail({
      to: current.email,
      userId: current.id,
      template: "welcome" as never,
      props: { plan: current.properties.plan },
    });
    const created = await ctx.waitForEvent({
      event: "project.created",
      timeout: days(3),
      where: (b) => b.prop("ready").eq(true),
    });
    if (created.timedOut) {
      await sendEmail({
        to: current.email,
        userId: current.id,
        template: "inactivity-nudge" as never,
      });
    }
  },
});

const effectsJourney = defineJourney({
  meta: {
    id: "effects",
    name: "Effects",
    enabled: true,
    trigger: { event: "effects.started" },
    entryLimit: "unlimited",
    suppress: hours(0),
  },
  run: async (current, ctx) => {
    await ctx.checkpoint("effects");
    await sendSms({
      to: "+420777123456",
      userId: current.id,
      template: "welcome-sms" as never,
      props: { plan: current.properties.plan },
    });
    await sendConnectorAction({
      connectorId: "discord",
      action: "sendMessage",
      args: { content: "hello" },
    });
    await sendFeedItem({
      recipient: { userId: current.id },
      type: "announcement",
      title: "Hello",
    });
    await ctx.trigger({
      event: "effects.finished",
      userId: current.id,
      properties: { ok: true },
    });
  },
});

describe("createJourneyTest", () => {
  it("runs future-event branches instantly and captures deep props", async () => {
    const test = createJourneyTest(journey, {
      user,
      now: "2026-07-14T09:00:00Z",
      timezone: "Europe/Prague",
    });
    test.events.after(days(2), "project.created", { ready: false });
    test.events.after({ hours: 60 }, "project.created", {
      ready: true,
      projectId: "p1",
    });
    await expect(test.run()).resolves.toBe("completed");
    expect(test.mailbox).toHaveSent("welcome", {
      props: { plan: "trial" },
      to: "dev@acme.com",
    });
    expect(test.mailbox).not.toHaveSent("inactivity-nudge");
    expect(test.virtualDurationMs).toBe(60 * 60 * 60 * 1000);
  });

  it("takes the deadline event and isolates other users", async () => {
    const test = createJourneyTest(journey, { user });
    test.events.after(
      days(1),
      "project.created",
      { ready: true },
      { userId: "other" },
    );
    test.events.after(days(3), "project.created", { ready: true });
    await test.run();
    expect(test.mailbox).toHaveSentTimes("welcome", 1);
    expect(test.mailbox).not.toHaveSent("inactivity-nudge");
    expect(test.virtualDurationMs).toBe(3 * 24 * 60 * 60 * 1000);
  });

  it("records an immediate guard change without exposing the constructor baseline", () => {
    const test = createJourneyTest(journey, { user });

    test.guard.setSubscribed(false);

    expect(test.timeline).toEqual([
      {
        type: "guard",
        at: "2025-01-01T00:00:00.000Z",
        subscribed: false,
      },
    ]);
  });

  it("interrupts a sleep or wait on exitOn", async () => {
    const test = createJourneyTest(journey, { user });
    test.events.after(days(1), "user.deleted");
    await expect(test.run()).resolves.toBe("exited");
    expect(test.effects.exits[0]?.source).toBe("exitOn");
  });

  it("checks enrollment policy with production reasons", () => {
    const test = createJourneyTest(journey, { user });
    expect(test.entry.check({ unsubscribed: true })).toEqual({
      allowed: false,
      reason: "user_unsubscribed",
    });
  });

  it("only allows one run", async () => {
    const test = createJourneyTest(journey, { user });
    await test.run();
    await expect(test.run()).rejects.toThrow("run() may only be called once");
  });

  it("captures SMS, connector, feed, checkpoints, and triggers", async () => {
    const test = createJourneyTest(effectsJourney, {
      user,
      smsConsent: "granted",
      connectorActions: [{ connectorId: "discord", name: "sendMessage" }],
    });
    await test.run();
    expect(test.mailbox).toHaveSent("welcome-sms", {
      channel: "sms",
      props: { plan: "trial" },
    });
    expect(test.effects.connectors).toHaveLength(1);
    expect(test.effects.feed).toHaveLength(1);
    expect(test.effects.checkpoints).toEqual([
      { label: "effects", at: "2025-01-01T00:00:00.000Z" },
    ]);
    expect(test.effects.triggers[0]).toMatchObject({
      event: "effects.finished",
      properties: { ok: true },
    });
    await expect(
      test.context.history.hasEvent({
        userId: user.id,
        event: "effects.finished",
      }),
    ).resolves.toEqual({ found: true, count: 1 });
  });

  it("applies subscription changes and seeded once values after virtual waits", async () => {
    const stateJourney = defineJourney({
      meta: {
        id: "state",
        name: "State",
        enabled: true,
        trigger: { event: "state.started" },
        entryLimit: "unlimited",
        suppress: hours(0),
      },
      run: async (current, ctx) => {
        await ctx.sleep({ duration: days(2), label: "settle" });
        const variant = await ctx.once("variant", () => "computed");
        if (await ctx.guard.isSubscribed()) {
          await sendEmail({
            to: current.email,
            userId: current.id,
            template: variant as never,
          });
        }
      },
    });
    const test = createJourneyTest(stateJourney, {
      user,
      once: { variant: "seeded" },
    });
    test.guard.after(days(1), false);
    await test.run();
    expect(test.mailbox).not.toHaveSent("seeded");
    expect(test.guard.isSubscribed()).toBe(false);
  });

  it("renders captured email props through the supplied registry", async () => {
    const templates = {
      welcome: {
        component: (props: { name: string }) =>
          createElement("p", null, `Hello ${props.name}`),
        defaultSubject: "Welcome subject",
      },
    } as unknown as TemplateRegistry;
    const renderJourney = defineJourney({
      meta: {
        id: "render",
        name: "Render",
        enabled: true,
        trigger: { event: "render.started" },
        entryLimit: "unlimited",
        suppress: hours(0),
      },
      run: async (current) => {
        await sendEmail({
          to: current.email,
          userId: current.id,
          template: "welcome" as never,
          props: { name: "Ada" },
        });
      },
    });
    const test = createJourneyTest(renderJourney, { user, templates });
    await test.run();
    const rendered = await test.mailbox.renderEmail("welcome");
    expect(rendered.subject).toBe("Welcome subject");
    expect(rendered.html).toContain("Hello Ada");
  });

  it("keeps parallel harness clocks and mailboxes isolated", async () => {
    const first = createJourneyTest(journey, {
      user,
      now: "2026-01-01T00:00:00Z",
    });
    const second = createJourneyTest(journey, {
      user: { ...user, id: "u2", email: "u2@acme.com" },
      now: "2030-01-01T00:00:00Z",
    });
    first.events.after(days(1), "project.created", { ready: true });
    await Promise.all([first.run(), second.run()]);
    expect(first.mailbox).not.toHaveSent("inactivity-nudge");
    expect(second.mailbox).toHaveSent("inactivity-nudge", {
      to: "u2@acme.com",
    });
    expect(first.now.toISOString()).toBe("2026-01-02T00:00:00.000Z");
    expect(second.now.toISOString()).toBe("2030-01-04T00:00:00.000Z");
  });

  it("fails loudly on duplicate idempotency sites", async () => {
    const duplicate = defineJourney({
      meta: {
        id: "duplicate",
        name: "Duplicate",
        enabled: true,
        trigger: { event: "duplicate.started" },
        entryLimit: "unlimited",
        suppress: hours(0),
      },
      run: async (current) => {
        const send = () =>
          sendEmail({
            to: current.email,
            userId: current.id,
            template: "same-template" as never,
          });
        await send();
        await send();
      },
    });
    const test = createJourneyTest(duplicate, { user });
    await expect(test.run()).rejects.toThrow("duplicate idempotency key");
    expect(test.mailbox).toHaveSentTimes("same-template", 1);
  });
});

describe("enrollment policy parity", () => {
  const conditioned = defineJourney({
    meta: {
      id: "conditioned",
      name: "Conditioned",
      enabled: true,
      trigger: {
        event: "conditioned.started",
        where: (builder) => builder.prop("plan").eq("trial"),
      },
      entryLimit: "once",
      suppress: hours(0),
    },
    run: async () => {},
  });

  it("honors the journey's disabled definition before all fixtures", () => {
    const disabled = defineJourney({
      meta: { ...conditioned.meta, id: "disabled", enabled: false },
      run: async () => {},
    });
    const test = createJourneyTest(disabled, { user });
    expect(
      test.entry.check({
        adminEnabled: false,
        entry: { allowed: false, reason: "entry_limit" },
        unsubscribed: true,
        heldOut: true,
        alreadyActive: true,
      }),
    ).toEqual({ allowed: false, reason: "journey_disabled" });
  });

  it.each([
    [{ adminEnabled: false }, { plan: "trial" }, "journey_disabled_by_admin"],
    [{}, { plan: "paid" }, "trigger_conditions_not_met"],
    [
      { entry: { allowed: false, reason: "already_entered_once" } },
      { plan: "trial" },
      "already_entered_once",
    ],
    [{ unsubscribed: true }, { plan: "trial" }, "user_unsubscribed"],
    [{ heldOut: true }, { plan: "trial" }, "held_out"],
    [{ alreadyActive: true }, { plan: "trial" }, "already_active"],
  ])("returns %s in production order", (facts, properties, reason) => {
    const test = createJourneyTest(conditioned, {
      user: { ...user, properties },
    });
    expect(test.entry.check(facts)).toEqual({ allowed: false, reason });
  });
});

describe("runJourneyScenarios", () => {
  it("isolates cases and continues after a failure", async () => {
    const result = await runJourneyScenarios(journey, [
      {
        name: "creates",
        user,
        events: [
          {
            after: days(1),
            event: "project.created",
            properties: { ready: true },
          },
        ],
      },
      {
        name: "fails setup",
        user: { ...user, id: "u2" },
        setup: () => {
          throw new Error("boom");
        },
      },
      { name: "quiet", user: { ...user, id: "u3" } },
    ]);
    expect(result.summary.outcomes).toEqual({
      completed: 2,
      exited: 0,
      failed: 1,
    });
    expect(result.summary.sends["email:welcome"]).toBe(2);
    expect(result.summary.sends["email:inactivity-nudge"]).toBe(1);
  });
});
