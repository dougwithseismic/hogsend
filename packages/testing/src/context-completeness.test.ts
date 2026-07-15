import { days, defineJourney, hours, minutes } from "@hogsend/engine/journeys";
import { describe, expect, it } from "vitest";
import { createJourneyTest } from "./index.js";

const user = {
  id: "u1",
  email: "dev@acme.com",
  properties: { plan: "trial" },
};

const meta = (id: string) => ({
  id,
  name: id,
  enabled: true,
  trigger: { event: `${id}.started` },
  entryLimit: "unlimited" as const,
  suppress: hours(0),
});

describe("JourneyContext completeness", () => {
  it("uses timezone-aware sleepUntil targets across a DST boundary", async () => {
    let before: string | undefined;
    let target: string | undefined;
    let after: string | undefined;
    const journey = defineJourney({
      meta: meta("dst-sleep"),
      run: async (_current, ctx) => {
        before = (await ctx.now()).toISOString();
        const instant = ctx.when.tomorrow().at("09:00");
        target = instant.toISOString();
        await ctx.sleepUntil(instant, { label: "tomorrow-morning" });
        after = (await ctx.now()).toISOString();
      },
    });
    const test = createJourneyTest(journey, {
      user,
      now: "2026-03-28T12:00:00.000Z",
      timezone: "Europe/Prague",
    });

    await test.run();
    expect(before).toBe("2026-03-28T12:00:00.000Z");
    expect(target).toBe("2026-03-29T07:00:00.000Z");
    expect(after).toBe(target);
    expect(test.effects.waits[0]).toMatchObject({
      type: "sleepUntil",
      outcome: "resumed",
      resumedAt: target,
    });
  });

  it("uses insertion order for equal-time forward events and latest-first lookback", async () => {
    let forward: unknown;
    let lookback: unknown;
    let filteredLookback: unknown;
    const journey = defineJourney({
      meta: meta("event-order"),
      run: async (_current, ctx) => {
        lookback = await ctx.waitForEvent({
          event: "answer.lookback",
          timeout: hours(1),
          lookback: minutes(5),
        });
        filteredLookback = await ctx.waitForEvent({
          event: "answer.filtered",
          timeout: hours(1),
          lookback: minutes(5),
          where: (builder) => builder.prop("ready").eq(true),
        });
        forward = await ctx.waitForEvent({
          event: "answer.forward",
          timeout: hours(1),
        });
      },
    });
    const test = createJourneyTest(journey, {
      user,
      now: "2026-07-14T09:00:00.000Z",
    });
    test.events.emit("answer.lookback", { order: 1 });
    test.events.emit("answer.lookback", { order: 2 });
    test.events.emit("answer.filtered", { ready: true });
    test.events.after(minutes(30), "answer.forward", { order: 1 });
    test.events.after(minutes(30), "answer.forward", { order: 2 });

    await test.run();
    expect(lookback).toEqual({
      timedOut: false,
      properties: { order: 2 },
      occurredAt: "2026-07-14T09:00:00.000Z",
    });
    expect(filteredLookback).toEqual({
      timedOut: false,
      properties: { ready: true },
    });
    expect(forward).toEqual({ timedOut: false, properties: { order: 1 } });
  });

  it("snapshots scripted events and history reads while normalizing fixture dates", async () => {
    const scheduledProperties = { ready: true };
    let matched: unknown;
    let firstHistory: unknown;
    let secondHistory: unknown;
    let emailHistory: unknown;
    let smsHistory: unknown;
    const journey = defineJourney({
      meta: meta("journal-snapshots"),
      run: async (current, ctx) => {
        matched = await ctx.waitForEvent({
          event: "answer",
          timeout: hours(1),
          where: (builder) => builder.prop("ready").eq(true),
        });
        const first = await ctx.history.events({
          userId: current.id,
          event: "seeded",
        });
        firstHistory = first;
        if (first[0]?.properties) first[0].properties.ready = false;
        secondHistory = await ctx.history.events({
          userId: current.id,
          event: "seeded",
        });
        emailHistory = await ctx.history.email({
          email: current.email,
          template: "welcome",
        });
        smsHistory = await ctx.history.sms({
          phone: "+15551234567",
          template: "welcome-sms",
        });
      },
    });
    const test = createJourneyTest(journey, {
      user,
      now: "2026-01-01T00:00:00.000Z",
      history: {
        events: [
          {
            event: "seeded",
            userId: user.id,
            occurredAt: "2026-01-01T01:00:00+01:00",
            properties: { ready: true },
          },
        ],
        emails: [
          {
            email: user.email,
            template: "welcome",
            sentAt: "2026-01-01T01:00:00+01:00",
          },
        ],
        sms: [
          {
            phone: "+15551234567",
            template: "welcome-sms",
            sentAt: "2026-01-01T01:00:00+01:00",
          },
        ],
      },
    });
    const scheduled = test.events.after(
      minutes(30),
      "answer",
      scheduledProperties,
    );
    scheduledProperties.ready = false;
    scheduled.properties.ready = false;

    await test.run();

    expect(matched).toEqual({ timedOut: false, properties: { ready: true } });
    expect(firstHistory).toEqual([
      {
        event: "seeded",
        properties: { ready: false },
        occurredAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    expect(secondHistory).toEqual([
      {
        event: "seeded",
        properties: { ready: true },
        occurredAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    expect(emailHistory).toMatchObject({
      sent: true,
      lastSentAt: "2026-01-01T00:00:00.000Z",
    });
    expect(smsHistory).toMatchObject({
      sent: true,
      lastSentAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it.each([
    "enteredAt",
    "completedAt",
  ] as const)("rejects an explicitly invalid journey history %s", (field) => {
    expect(() =>
      createJourneyTest(
        defineJourney({
          meta: meta(`invalid-journey-${field}`),
          run: async () => {},
        }),
        {
          user,
          history: {
            journeys: [
              {
                userId: user.id,
                journeyId: "prior",
                [field]: "",
              },
            ],
          },
        },
      ),
    ).toThrow(`journey history ${field}: invalid date`);
  });

  it("caps digests deterministically and marks truncation", async () => {
    let digest: unknown;
    const journey = defineJourney({
      meta: meta("digest-cap"),
      run: async (_current, ctx) => {
        digest = await ctx.digest({
          event: "activity",
          window: hours(1),
          lookback: hours(0),
          maxEvents: 2,
        });
      },
    });
    const test = createJourneyTest(journey, {
      user,
      now: "2026-07-14T09:00:00.000Z",
    });
    test.events.after(minutes(10), "activity", { n: 1 });
    test.events.after(minutes(20), "activity", { n: 2 });
    test.events.after(minutes(30), "activity", { n: 3 });

    await test.run();
    expect(digest).toMatchObject({
      count: 2,
      truncated: true,
      events: [{ properties: { n: 1 } }, { properties: { n: 2 } }],
      flushedAt: "2026-07-14T10:00:00.000Z",
    });
  });

  it("makes email, SMS, event history and throttle time-aware", async () => {
    const snapshots: unknown[] = [];
    const journey = defineJourney({
      meta: meta("history-complete"),
      run: async (current, ctx) => {
        snapshots.push(
          await ctx.history.email({
            email: current.email,
            template: "welcome",
          }),
          await ctx.history.sms({
            phone: "+15551234567",
            template: "welcome-sms",
          }),
          await ctx.history.hasEvent({
            userId: current.id,
            event: "milestone",
          }),
          await ctx.throttle({
            label: "before",
            limit: 2,
            window: days(7),
            category: "journey",
          }),
        );
        await ctx.sleep({ duration: days(2), label: "cross-history" });
        snapshots.push(
          await ctx.history.email({
            email: current.email,
            template: "welcome",
          }),
          await ctx.history.sms({
            phone: "+15551234567",
            template: "welcome-sms",
          }),
          await ctx.history.hasEvent({
            userId: current.id,
            event: "milestone",
          }),
          await ctx.history.events({ userId: current.id, limit: 2 }),
          await ctx.throttle({
            label: "after",
            limit: 2,
            window: days(7),
            category: "journey",
          }),
        );
      },
    });
    const test = createJourneyTest(journey, {
      user,
      now: "2026-07-14T09:00:00.000Z",
      history: {
        emails: [
          {
            email: user.email,
            template: "welcome",
            category: "journey",
            sentAt: "2026-07-13T09:00:00.000Z",
          },
          {
            email: user.email,
            template: "welcome",
            category: "journey",
            sentAt: "2026-07-15T09:00:00.000Z",
          },
        ],
        sms: [
          {
            phone: "+15551234567",
            template: "welcome-sms",
            sentAt: "2026-07-13T09:00:00.000Z",
          },
          {
            phone: "+15551234567",
            template: "welcome-sms",
            sentAt: "2026-07-15T09:00:00.000Z",
          },
        ],
        events: [
          {
            event: "milestone",
            userId: user.id,
            occurredAt: "2026-07-15T09:00:00.000Z",
            properties: { step: 2 },
          },
        ],
      },
    });

    await test.run();
    expect(snapshots[0]).toMatchObject({ sent: true, count: 1 });
    expect(snapshots[1]).toMatchObject({ sent: true, count: 1 });
    expect(snapshots[2]).toEqual({ found: false, count: 0 });
    expect(snapshots[3]).toEqual({ allowed: true, count: 1, remaining: 1 });
    expect(snapshots[4]).toMatchObject({ sent: true, count: 2 });
    expect(snapshots[5]).toMatchObject({ sent: true, count: 2 });
    expect(snapshots[6]).toEqual({ found: true, count: 1 });
    expect(snapshots[7]).toEqual([
      {
        event: "milestone",
        properties: { step: 2 },
        occurredAt: "2026-07-15T09:00:00.000Z",
      },
      {
        event: "history-complete.started",
        properties: { plan: "trial" },
        occurredAt: "2026-07-14T09:00:00.000Z",
      },
    ]);
    expect(snapshots[8]).toEqual({ allowed: false, count: 2, remaining: 0 });
  });

  it("captures checkpoints, manual exits, and trigger loopback", async () => {
    let loopback: unknown;
    const targetJourney = defineJourney({
      meta: meta("loopback-target"),
      run: async (_current, ctx) => {
        loopback = await ctx.waitForEvent({
          event: "loopback.event",
          timeout: hours(1),
          lookback: minutes(5),
        });
      },
    });
    const target = createJourneyTest(targetJourney, { user });

    const sourceJourney = defineJourney({
      meta: meta("loopback-source"),
      run: async (current, ctx) => {
        await ctx.checkpoint("before-loopback");
        await ctx.trigger({
          event: "loopback.event",
          userId: current.id,
          properties: { linked: true },
        });
        await ctx.exit("done");
      },
    });
    const source = createJourneyTest(sourceJourney, {
      user,
      onTrigger: (trigger) => {
        target.events.emit(trigger.event, trigger.properties, {
          userId: trigger.userId,
          userEmail: trigger.userEmail,
        });
      },
    });

    await expect(source.run()).resolves.toBe("exited");
    await target.run();
    expect(source.effects.checkpoints).toEqual([
      { label: "before-loopback", at: "2025-01-01T00:00:00.000Z" },
    ]);
    expect(source.effects.triggers[0]?.userEmail).toBe(user.email);
    expect(source.effects.exits).toEqual([
      {
        reason: "done",
        at: "2025-01-01T00:00:00.000Z",
        source: "manual",
      },
    ]);
    expect(loopback).toEqual({
      timedOut: false,
      properties: { linked: true },
      occurredAt: "2025-01-01T00:00:00.000Z",
    });
  });
});
