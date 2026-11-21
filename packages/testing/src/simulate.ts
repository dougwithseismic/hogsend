import { durationToMs } from "@hogsend/core";
import { createScenarioTest } from "./scenarios.js";
import type {
  JourneyDefinition,
  JourneyScenario,
  JourneySimulation,
  SimulateJourneyOptions,
  SimulationSendStatus,
  SimulationStep,
  TimelineEntry,
} from "./types.js";

const SEND_STATUSES = new Set<SimulationSendStatus>([
  "suppressed",
  "unsubscribed",
  "no_consent",
  "skipped",
]);
const WAIT_TYPES = new Set(["sleep", "sleepUntil", "waitForEvent", "digest"]);

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const sendStatus = (entry: TimelineEntry): SimulationSendStatus => {
  const status = entry.status as SimulationSendStatus | undefined;
  return status && SEND_STATUSES.has(status) ? status : "sent";
};

/** Map one harness timeline entry to a simulation step (or drop it). */
function toStep(entry: TimelineEntry): SimulationStep | undefined {
  const at = entry.at;
  if (WAIT_TYPES.has(entry.type)) {
    return {
      kind: "wait",
      at,
      wait: entry.type as "sleep" | "sleepUntil" | "waitForEvent" | "digest",
      label: String(entry.label ?? ""),
      ...(typeof entry.durationMs === "number"
        ? { durationMs: entry.durationMs }
        : {}),
      ...(str(entry.event) ? { event: str(entry.event) } : {}),
      outcome: entry.outcome as "resumed" | "matched" | "timedOut" | "exited",
      resumedAt: String(entry.resumedAt ?? at),
      ...(str(entry.source) ? { source: str(entry.source) } : {}),
    };
  }
  switch (entry.type) {
    case "event": {
      const event = String(entry.event);
      const properties = record(entry.properties);
      if (entry.source === "enrollment")
        return { kind: "enrolled", at, event, properties };
      // A ctx.trigger is also journaled as an event; the trigger step covers it.
      if (entry.source === "trigger") return undefined;
      return {
        kind: "event",
        at,
        event,
        userId: String(entry.userId ?? ""),
        properties,
      };
    }
    case "checkpoint":
      return { kind: "checkpoint", at, label: String(entry.label) };
    case "variant":
      return {
        kind: "variant",
        at,
        key: String(entry.key),
        arm: String(entry.arm),
      };
    case "guard":
      return { kind: "guard", at, subscribed: entry.subscribed === true };
    case "trigger":
      return {
        kind: "trigger",
        at,
        event: String(entry.event),
        userId: String(entry.userId ?? ""),
        properties: record(entry.properties),
      };
    case "exit":
      return {
        kind: "exit",
        at,
        source: entry.source === "manual" ? "manual" : "exitOn",
        ...(str(entry.reason) ? { reason: str(entry.reason) } : {}),
      };
    case "email":
    case "sms": {
      const status = sendStatus(entry);
      return {
        kind: "send",
        at,
        channel: entry.type,
        status,
        template: String(entry.template),
        ...(str(entry.to) ? { to: str(entry.to) } : {}),
        ...(str(entry.subject) ? { subject: str(entry.subject) } : {}),
        ...(str(entry.category) ? { category: str(entry.category) } : {}),
        ...(status !== "sent" ? { reason: str(entry.reason) ?? status } : {}),
        ...(str(entry.idempotencyLabel)
          ? { idempotencyLabel: str(entry.idempotencyLabel) }
          : {}),
      };
    }
    case "feed": {
      const status = sendStatus(entry);
      const recipient = record(entry.recipient);
      const to =
        str(entry.recipientKey) ??
        str(recipient.userId) ??
        str(recipient.email) ??
        str(recipient.anonymousId);
      return {
        kind: "send",
        at,
        channel: "feed",
        status,
        template: String(entry.feedType),
        ...(to ? { to } : {}),
        ...(str(entry.title) ? { subject: str(entry.title) } : {}),
        ...(str(entry.category) ? { category: str(entry.category) } : {}),
        ...(status !== "sent" ? { reason: str(entry.reason) ?? status } : {}),
        ...(str(entry.idempotencyLabel)
          ? { idempotencyLabel: str(entry.idempotencyLabel) }
          : {}),
      };
    }
    case "connector": {
      const status = sendStatus(entry);
      return {
        kind: "send",
        at,
        channel: "connector",
        status,
        template: `${String(entry.connectorId)}:${String(entry.action)}`,
        ...(status !== "sent" ? { reason: str(entry.reason) ?? status } : {}),
        ...(str(entry.idempotencyLabel)
          ? { idempotencyLabel: str(entry.idempotencyLabel) }
          : {}),
      };
    }
    default:
      return undefined;
  }
}

const describeError = (
  error: unknown,
): { name: string; message: string; stack?: string } =>
  error instanceof Error
    ? {
        name: error.name,
        message: error.message,
        ...(error.stack ? { stack: error.stack } : {}),
      }
    : { name: "Error", message: String(error) };

/**
 * Run one scenario through the harness on virtual time and return a stable,
 * JSON-serializable timeline: enrollment, waits and how they resumed,
 * checkpoints, variant arms, every send attempt, cross-journey triggers,
 * subscription changes, and the final status.
 *
 * Unlike {@link createJourneyTest}, this applies the production enrollment
 * guards first (disabled journey, `trigger.where`, entry limit, unsubscribe,
 * holdout, already active) and reports `skipped` when they refuse the user,
 * unless `force` is set. A journey that throws is reported as `failed`;
 * invalid scenario input (a malformed date, conflicting `at`/`after`) throws.
 */
export async function simulateJourney(
  journey: JourneyDefinition,
  scenario: JourneyScenario,
  options: SimulateJourneyOptions = {},
): Promise<JourneySimulation> {
  const test = createScenarioTest(journey, scenario);
  await scenario.setup?.(test);

  const startedAt = test.now.toISOString();
  const startMs = test.now.getTime();
  const verdict = test.entry.check();
  const base = {
    journey: {
      id: journey.meta.id,
      name: journey.meta.name,
      trigger: journey.meta.trigger.event,
      exitOn: (journey.meta.exitOn ?? []).map((exit) => exit.event),
    },
    scenario: scenario.name,
    user: { id: scenario.user.id, email: scenario.user.email },
    startedAt,
  };
  const entry = verdict.allowed
    ? { allowed: true }
    : {
        allowed: false,
        reason: verdict.reason,
        ...(options.force ? { forced: true } : {}),
      };

  if (!verdict.allowed && !options.force) {
    return {
      ...base,
      endedAt: startedAt,
      virtualDurationMs: 0,
      status: "skipped",
      entry,
      steps: [{ kind: "skipped", at: startedAt, reason: verdict.reason }],
      notReached: [],
      summary: {
        sent: { email: 0, sms: 0, feed: 0, connector: 0 },
        blocked: 0,
        triggers: 0,
        waits: 0,
      },
    };
  }

  let status: JourneySimulation["status"];
  let failure: unknown;
  try {
    status = await test.run();
  } catch (error) {
    status = "failed";
    failure = error;
  }

  const endedAt = test.now.toISOString();
  const steps = test.timeline
    .map(toStep)
    .filter((step): step is SimulationStep => step !== undefined)
    // History fixtures are journaled too; only show what happened in the run.
    .filter(
      (step) => step.kind !== "event" || new Date(step.at).getTime() >= startMs,
    );
  if (status === "completed") steps.push({ kind: "completed", at: endedAt });
  if (status === "failed") {
    steps.push({
      kind: "failed",
      at: endedAt,
      error: describeError(failure).message,
    });
  }

  const endMs = test.now.getTime();
  const notReached = (scenario.events ?? [])
    .map((event) => ({
      at: new Date(
        event.at !== undefined
          ? new Date(event.at).getTime()
          : startMs + durationToMs(event.after ?? {}),
      ).toISOString(),
      event: event.event,
    }))
    .filter((event) => new Date(event.at).getTime() > endMs)
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  const sent = { email: 0, sms: 0, feed: 0, connector: 0 };
  let blocked = 0;
  let triggers = 0;
  let waits = 0;
  for (const step of steps) {
    if (step.kind === "send") {
      if (step.status === "sent") sent[step.channel] += 1;
      else blocked += 1;
    } else if (step.kind === "trigger") triggers += 1;
    else if (step.kind === "wait") waits += 1;
  }
  const exit = test.effects.exits[0];

  return {
    ...base,
    endedAt,
    virtualDurationMs: test.virtualDurationMs,
    status,
    entry,
    ...(status === "exited" && exit
      ? {
          exit: {
            source: exit.source,
            ...(exit.reason ? { reason: exit.reason } : {}),
          },
        }
      : {}),
    ...(status === "failed" ? { error: describeError(failure) } : {}),
    steps,
    notReached,
    summary: { sent, blocked, triggers, waits },
  };
}
