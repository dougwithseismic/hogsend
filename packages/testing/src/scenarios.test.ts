import {
  hours,
  sendConnectorAction,
  sendEmail,
} from "@hogsend/engine/journeys";
import { describe, expect, it } from "vitest";
import { runJourneyScenarios } from "./scenarios.js";
import type {
  JourneyDefinition,
  JourneyScenario,
  TestJourneyUser,
} from "./types.js";

const user: TestJourneyUser = {
  id: "user-1",
  email: "dev@example.com",
  properties: {},
};

const journey: JourneyDefinition = {
  meta: {
    id: "scenario-isolation",
    name: "Scenario isolation",
    enabled: true,
    trigger: { event: "user.created" },
    entryLimit: "unlimited",
    suppress: hours(0),
  },
  run: async (_current, ctx) => {
    await ctx.checkpoint("ran");
  },
};

const connectorJourney: JourneyDefinition = {
  ...journey,
  run: async () => {
    await sendConnectorAction({
      connectorId: "discord",
      action: "sendMessage",
      args: { content: "hello" },
    });
  },
};

describe("runJourneyScenarios failure isolation", () => {
  it("captures harness-construction failures and continues later rows", async () => {
    const result = await runJourneyScenarios(journey, [
      { name: "invalid clock", user, now: "not-an-instant" },
      { name: "still runs", user: { ...user, id: "user-2" } },
    ]);

    expect(
      result.results.map(({ name, status }) => ({ name, status })),
    ).toEqual([
      { name: "invalid clock", status: "failed" },
      { name: "still runs", status: "completed" },
    ]);
    expect(result.results[0]).toMatchObject({
      virtualDurationMs: 0,
      mailbox: [],
      triggers: [],
      checkpoints: [],
      timeline: [],
    });
    expect(result.results[0]?.error).toBeInstanceOf(Error);
    expect(result.results[1]?.checkpoints).toHaveLength(1);
    expect(result.summary.outcomes).toEqual({
      completed: 1,
      exited: 0,
      failed: 1,
    });
  });

  it("captures event-script failures and continues later rows", async () => {
    const result = await runJourneyScenarios(journey, [
      {
        name: "invalid event instant",
        user,
        events: [{ event: "project.created", at: "not-an-instant" }],
      },
      { name: "still runs", user: { ...user, id: "user-2" } },
    ]);

    expect(result.results.map(({ status }) => status)).toEqual([
      "failed",
      "completed",
    ]);
    expect(result.results[0]?.error).toBeInstanceOf(Error);
    expect(result.results[1]?.checkpoints[0]?.label).toBe("ran");
  });

  it("rejects ambiguous event timing inside only the malformed row", async () => {
    const result = await runJourneyScenarios(journey, [
      {
        name: "ambiguous event",
        user,
        events: [
          {
            event: "project.created",
            at: "2025-01-02T00:00:00.000Z",
            after: hours(24),
          },
        ],
      },
      { name: "still runs", user: { ...user, id: "user-2" } },
    ]);

    expect(result.results.map(({ status }) => status)).toEqual([
      "failed",
      "completed",
    ]);
    expect(result.results[0]?.error).toMatchObject({
      message: expect.stringContaining('either "at" or "after"'),
    });
  });

  it("passes registered connector actions into each scenario harness", async () => {
    const result = await runJourneyScenarios(connectorJourney, [
      {
        name: "connector",
        user,
        connectorActions: [{ connectorId: "discord", name: "sendMessage" }],
      },
    ]);

    expect(result.results[0]?.status).toBe("completed");
    expect(result.results[0]?.timeline).toContainEqual(
      expect.objectContaining({
        type: "connector",
        connectorId: "discord",
        action: "sendMessage",
      }),
    );
  });

  it("isolates a shared user fixture from journey mutations between rows", async () => {
    const plans: unknown[] = [];
    const mutatingJourney: JourneyDefinition = {
      ...journey,
      run: async (current) => {
        plans.push(current.properties.plan);
        current.properties.plan = "mutated";
      },
    };
    const sharedUser: TestJourneyUser = {
      ...user,
      properties: { plan: "trial" },
    };

    const result = await runJourneyScenarios(mutatingJourney, [
      { name: "first", user: sharedUser },
      { name: "second", user: sharedUser },
    ]);

    expect(result.results.map(({ status }) => status)).toEqual([
      "completed",
      "completed",
    ]);
    expect(plans).toEqual(["trial", "trial"]);
    expect(sharedUser.properties).toEqual({ plan: "trial" });
  });

  it("does not expose the shared scenario fixture through test.options", async () => {
    const plans: unknown[] = [];
    const inspectingJourney: JourneyDefinition = {
      ...journey,
      run: async (current) => {
        plans.push(current.properties.plan);
      },
    };
    const sharedUser: TestJourneyUser = {
      ...user,
      properties: { plan: "trial" },
    };

    const result = await runJourneyScenarios(inspectingJourney, [
      {
        name: "mutates exposed options",
        user: sharedUser,
        setup: (test) => {
          test.options.user.properties.plan = "mutated";
        },
      },
      { name: "must stay isolated", user: sharedUser },
    ]);

    expect(result.results.map(({ status }) => status)).toEqual([
      "completed",
      "completed",
    ]);
    expect(plans).toEqual(["mutated", "trial"]);
    expect(sharedUser.properties).toEqual({ plan: "trial" });
  });

  it("counts prototype-shaped trigger and checkpoint names as ordinary keys", async () => {
    const keyedJourney: JourneyDefinition = {
      ...journey,
      run: async (current, ctx) => {
        await ctx.checkpoint("toString");
        await ctx.trigger({ event: "__proto__", userId: current.id });
      },
    };

    const result = await runJourneyScenarios(keyedJourney, [
      { name: "prototype keys", user },
    ]);

    expect(Object.hasOwn(result.summary.checkpoints, "toString")).toBe(true);
    expect(result.summary.checkpoints.toString).toBe(1);
    expect(Object.hasOwn(result.summary.triggers, "__proto__")).toBe(true);
    expect(result.summary.triggers.__proto__).toBe(1);
  });

  it("snapshots completed rows before a retained harness can be mutated", async () => {
    let firstHarness:
      | Parameters<NonNullable<JourneyScenario["setup"]>>[0]
      | undefined;
    const mailJourney: JourneyDefinition = {
      ...journey,
      run: async (current) => {
        await sendEmail({
          to: current.email,
          userId: current.id,
          template: "original" as never,
        });
      },
    };

    const result = await runJourneyScenarios(mailJourney, [
      {
        name: "retained",
        user,
        setup: (test) => {
          firstHarness = test;
        },
      },
      {
        name: "later mutation",
        user: { ...user, id: "user-2" },
        setup: () => {
          const firstMessage = firstHarness?.mailbox.messages[0];
          if (firstMessage) firstMessage.template = "corrupted";
        },
      },
    ]);

    expect(result.results[0]?.mailbox[0]?.template).toBe("original");
    expect(result.summary.sends).toEqual({ "email:original": 2 });
  });
});
