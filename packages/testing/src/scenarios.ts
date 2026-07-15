import { createJourneyTest } from "./harness.js";
import type {
  JourneyDefinition,
  JourneyScenario,
  JourneyScenarioResult,
  JourneyScenarioRun,
} from "./types.js";

const increment = (target: Record<string, number>, key: string): void => {
  const current = Object.hasOwn(target, key) ? (target[key] ?? 0) : 0;
  Object.defineProperty(target, key, {
    value: current + 1,
    writable: true,
    enumerable: true,
    configurable: true,
  });
};

const snapshot = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export async function runJourneyScenarios(
  journey: JourneyDefinition,
  scenarios: JourneyScenario[],
): Promise<JourneyScenarioRun> {
  const results: JourneyScenarioResult[] = [];
  for (const scenario of scenarios) {
    let test: ReturnType<typeof createJourneyTest> | undefined;
    try {
      // Harness construction and event scripting are part of the scenario, not
      // runner setup. Keep them inside the row boundary so a malformed date or
      // event in one table row is reported as that row's failure and later rows
      // still receive their own fresh harness.
      test = createJourneyTest(journey, {
        user: scenario.user,
        now: scenario.now,
        timezone: scenario.timezone,
        templates: scenario.templates,
        smsTemplates: scenario.smsTemplates,
        smsConsent: scenario.smsConsent,
        preferences: scenario.preferences,
        connectorActions: scenario.connectorActions,
      });
      for (const event of scenario.events ?? []) {
        if (event.at !== undefined && event.after !== undefined) {
          throw new Error(
            `Scenario event "${event.event}" must specify either "at" or "after", not both.`,
          );
        }
        const target = { userId: event.userId, userEmail: event.userEmail };
        if (event.at !== undefined)
          test.events.at(event.at, event.event, event.properties, target);
        else
          test.events.after(
            event.after ?? {},
            event.event,
            event.properties,
            target,
          );
      }
      await scenario.setup?.(test);
      const status = await test.run();
      results.push({
        name: scenario.name,
        status,
        virtualDurationMs: test.virtualDurationMs,
        mailbox: snapshot(test.mailbox.messages),
        triggers: snapshot(test.effects.triggers),
        checkpoints: snapshot(test.effects.checkpoints),
        timeline: snapshot(test.timeline),
      });
    } catch (error) {
      results.push({
        name: scenario.name,
        status: "failed",
        virtualDurationMs: test?.virtualDurationMs ?? 0,
        mailbox: test ? snapshot(test.mailbox.messages) : [],
        triggers: test ? snapshot(test.effects.triggers) : [],
        checkpoints: test ? snapshot(test.effects.checkpoints) : [],
        timeline: test ? snapshot(test.timeline) : [],
        error,
      });
    }
  }

  const outcomes = { completed: 0, exited: 0, failed: 0 };
  const sends: Record<string, number> = {};
  const triggers: Record<string, number> = {};
  const checkpoints: Record<string, number> = {};
  for (const result of results) {
    outcomes[result.status] += 1;
    for (const message of result.mailbox)
      increment(sends, `${message.channel}:${message.template}`);
    for (const trigger of result.triggers) increment(triggers, trigger.event);
    for (const checkpoint of result.checkpoints)
      increment(checkpoints, checkpoint.label);
  }
  const durations = results.map((result) => result.virtualDurationMs);
  return {
    results,
    summary: {
      outcomes,
      sends,
      triggers,
      checkpoints,
      virtualDurationMs: {
        min: durations.length ? Math.min(...durations) : 0,
        average: durations.length
          ? durations.reduce((sum, value) => sum + value, 0) / durations.length
          : 0,
        max: durations.length ? Math.max(...durations) : 0,
      },
    },
  };
}
