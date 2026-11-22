import type { JourneySimulation } from "@hogsend/testing";
import { describe, expect, it } from "vitest";
import {
  formatMarkdown,
  formatOffset,
  formatText,
  humanDuration,
  summaryLine,
  timelineRows,
} from "../lib/simulate-format.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const start = "2026-03-02T09:00:00.000Z";
const at = (ms: number) => new Date(Date.parse(start) + ms).toISOString();

const report = (
  overrides: Partial<JourneySimulation> = {},
): JourneySimulation => ({
  journey: {
    id: "trial-upgrade",
    name: "Trial upgrade",
    trigger: "trial.started",
    exitOn: ["subscription.created"],
  },
  scenario: "converts",
  user: { id: "u1", email: "ada@example.com" },
  startedAt: start,
  endedAt: at(9 * DAY),
  virtualDurationMs: 9 * DAY,
  horizon: { at: at(30 * DAY), durationMs: 30 * DAY },
  status: "exited",
  entry: { allowed: true },
  exit: { source: "exitOn", reason: "subscription.created" },
  steps: [
    {
      kind: "enrolled",
      at: start,
      event: "trial.started",
      properties: {},
    },
    { kind: "variant", at: start, key: "welcome-subject", arm: "short" },
    {
      kind: "send",
      at: start,
      channel: "email",
      status: "sent",
      template: "trial-welcome",
      to: "ada@example.com",
      subject: "Welcome | hello",
      category: "journey",
    },
    { kind: "checkpoint", at: start, label: "welcomed" },
    {
      kind: "wait",
      at: start,
      wait: "waitForEvent",
      label: "await-project",
      durationMs: 2 * DAY,
      event: "project.created",
      outcome: "timedOut",
      resumedAt: at(2 * DAY),
    },
    {
      kind: "send",
      at: at(2 * DAY),
      channel: "sms",
      status: "no_consent",
      template: "trial-nudge-sms",
      to: "+15551234567",
      reason: "no_consent",
      idempotencyLabel: "nudge",
    },
    {
      kind: "event",
      at: at(3 * DAY),
      event: "feature.used",
      userId: "u1",
      properties: { feature: "export" },
    },
    { kind: "guard", at: at(4 * DAY), subscribed: false },
    {
      kind: "wait",
      at: at(2 * DAY),
      wait: "sleep",
      label: "trial-ending",
      durationMs: 5 * DAY + 6 * HOUR,
      outcome: "resumed",
      resumedAt: at(7 * DAY + 6 * HOUR),
    },
    {
      kind: "send",
      at: at(7 * DAY + 6 * HOUR),
      channel: "email",
      status: "sent",
      template: "trial-ending",
      to: "ada@example.com",
      idempotencyLabel: "ending-reminder",
    },
    {
      kind: "trigger",
      at: at(7 * DAY + 6 * HOUR),
      event: "trial.lapsed",
      userId: "u1",
      properties: {},
    },
    {
      kind: "wait",
      at: at(7 * DAY + 6 * HOUR),
      wait: "sleep",
      label: "trial-over",
      durationMs: 2 * DAY,
      outcome: "exited",
      resumedAt: at(9 * DAY),
    },
    {
      kind: "exit",
      at: at(9 * DAY),
      source: "exitOn",
      reason: "subscription.created",
    },
  ],
  notReached: [{ at: at(12 * DAY), event: "feature.used" }],
  summary: {
    sent: { email: 2, sms: 0, feed: 0, connector: 0 },
    blocked: 1,
    triggers: 1,
    waits: 3,
  },
  ...overrides,
});

describe("time helpers", () => {
  it("formats offsets from the run start", () => {
    expect(formatOffset(0)).toBe("+0m");
    expect(formatOffset(-5)).toBe("+0m");
    expect(formatOffset(45_000)).toBe("+45s");
    expect(formatOffset(30 * 60_000)).toBe("+30m");
    expect(formatOffset(6 * HOUR)).toBe("+6h");
    expect(formatOffset(2 * DAY + 6 * HOUR + 30 * 60_000)).toBe("+2d 6h 30m");
    expect(formatOffset(9 * DAY)).toBe("+9d");
  });

  it("rounds before splitting an offset into units", () => {
    expect(formatOffset(119_600)).toBe("+2m");
    expect(formatOffset(59_600)).toBe("+1m");
    expect(formatOffset(400)).toBe("+0m");
    expect(formatOffset(HOUR - 400)).toBe("+1h");
    // Above an hour seconds are not shown, so round to the minute.
    expect(formatOffset(HOUR + 59_000)).toBe("+1h 1m");
    expect(formatOffset(DAY - 20_000)).toBe("+1d");
  });

  it("humanizes the run length to at most two units", () => {
    expect(humanDuration(0)).toBe("under a minute");
    expect(humanDuration(60_000)).toBe("1 minute");
    expect(humanDuration(HOUR)).toBe("1 hour");
    expect(humanDuration(9 * DAY)).toBe("9 days");
    expect(humanDuration(DAY + 6 * HOUR + 20 * 60_000)).toBe("1 day 6 hours");
    expect(humanDuration(HOUR - 20_000)).toBe("1 hour");
  });
});

describe("summaryLine", () => {
  it("counts sends per channel and names the exit event", () => {
    expect(summaryLine(report())).toBe(
      "2 emails (1 blocked) over 9 days; exits on `subscription.created`.",
    );
  });

  it("describes completed, failed, skipped and manual exits", () => {
    expect(
      summaryLine(
        report({
          status: "completed",
          exit: undefined,
          summary: {
            sent: { email: 1, sms: 2, feed: 1, connector: 0 },
            blocked: 0,
            triggers: 0,
            waits: 0,
          },
        }),
      ),
    ).toBe("1 email, 2 SMS, 1 feed item over 9 days; completes.");
    expect(
      summaryLine(
        report({
          status: "failed",
          exit: undefined,
          virtualDurationMs: 0,
          error: { name: "Error", message: "boom" },
          summary: {
            sent: { email: 0, sms: 0, feed: 0, connector: 0 },
            blocked: 0,
            triggers: 0,
            waits: 0,
          },
        }),
      ),
    ).toBe("No messages; fails: boom");
    expect(
      summaryLine(
        report({
          status: "skipped",
          entry: { allowed: false, reason: "already_entered_once" },
        }),
      ),
    ).toBe("Not enrolled: `already_entered_once` (enrollment guard).");
    expect(
      summaryLine(report({ exit: { source: "manual", reason: "converted" } })),
    ).toBe("2 emails (1 blocked) over 9 days; exits early: converted.");
  });

  it("describes a run still waiting at the horizon", () => {
    expect(
      summaryLine(
        report({
          status: "running",
          exit: undefined,
          virtualDurationMs: 30 * DAY,
        }),
      ),
    ).toBe("2 emails (1 blocked) over 30 days; still running at the horizon.");
  });
});

describe("timelineRows", () => {
  it("renders one row per step with offsets and wait outcomes", () => {
    const rows = timelineRows(report());
    expect(rows.map((row) => [row.time, row.step])).toEqual([
      ["+0m", "Enrolled"],
      ["+0m", "Variant"],
      ["+0m", "Email"],
      ["+0m", "Checkpoint"],
      ["+0m", "Wait for event"],
      ["+2d", "SMS (blocked)"],
      ["+3d", "Event"],
      ["+4d", "Unsubscribed"],
      ["+2d", "Sleep"],
      ["+7d 6h", "Email"],
      ["+7d 6h", "Trigger"],
      ["+7d 6h", "Sleep"],
      ["+9d", "Exited"],
    ]);
    expect(rows[4]?.detail).toEqual([
      { code: "await-project" },
      ": ",
      { code: "project.created" },
      " up to 2d",
      " → timed out at +2d",
    ]);
    expect(rows[11]?.tone).toBe("warn");
  });

  it("renders the horizon wait and the still-running row", () => {
    const rows = timelineRows(
      report({
        status: "running",
        exit: undefined,
        endedAt: at(30 * DAY),
        steps: [
          {
            kind: "enrolled",
            at: start,
            event: "trial.started",
            properties: {},
          },
          {
            kind: "wait",
            at: at(28 * DAY),
            wait: "sleep",
            label: "week-5",
            durationMs: 7 * DAY,
            outcome: "horizon",
            resumedAt: at(30 * DAY),
          },
          { kind: "horizon", at: at(30 * DAY) },
        ],
      }),
    );
    expect(rows.map((row) => [row.time, row.step, row.tone])).toEqual([
      ["+0m", "Enrolled", "good"],
      ["+28d", "Sleep", "warn"],
      ["+30d", "Still running", "warn"],
    ]);
    expect(rows[1]?.detail).toEqual([
      { code: "week-5" },
      " for 7d",
      " → still waiting at +30d (horizon)",
    ]);
    expect(rows[2]?.detail).toEqual([
      "stopped at the simulation horizon (+30d); extend it with ",
      { code: "--until" },
    ]);
  });
});

describe("formatMarkdown", () => {
  it("renders a PR-comment section with an escaped table", () => {
    expect(formatMarkdown([report()])).toBe(
      [
        "### `trial-upgrade` · converts",
        "",
        "**2 emails (1 blocked) over 9 days; exits on `subscription.created`.**",
        "",
        "User `u1` (ada@example.com) · starts 2026-03-02 09:00 UTC",
        "",
        "| Time | Step | Detail |",
        "| --- | --- | --- |",
        "| +0m | Enrolled | on `trial.started` |",
        "| +0m | Variant | `welcome-subject` → `short` |",
        '| +0m | Email | `trial-welcome` → ada@example.com · "Welcome \\| hello" |',
        "| +0m | Checkpoint | `welcomed` |",
        "| +0m | Wait for event | `await-project`: `project.created` up to 2d → timed out at +2d |",
        "| +2d | SMS (blocked) | `trial-nudge-sms` → +15551234567 · label `nudge` · blocked: `no_consent` |",
        '| +3d | Event | `feature.used` `{"feature":"export"}` |',
        "| +4d | Unsubscribed | global subscription off |",
        "| +2d | Sleep | `trial-ending` for 5d 6h → resumed at +7d 6h |",
        "| +7d 6h | Email | `trial-ending` → ada@example.com · label `ending-reminder` |",
        "| +7d 6h | Trigger | `trial.lapsed` |",
        "| +7d 6h | Sleep | `trial-over` for 2d → interrupted by exit at +9d |",
        "| +9d | Exited | `subscription.created` (exitOn) |",
        "",
        "_Not reached (the run ended first): `feature.used` at +12d._",
      ].join("\n"),
    );
  });

  it("notes a forced run and separates multiple reports", () => {
    const forced = report({
      scenario: "returning",
      entry: { allowed: false, reason: "already_entered_once", forced: true },
    });
    const output = formatMarkdown([report(), forced]);
    expect(output).toContain(
      "> Enrollment guard would skip this user (`already_entered_once`); simulated anyway with --force.",
    );
    expect(output.split("### ").length - 1).toBe(2);
    expect(output).toContain("_\n\n### `trial-upgrade` · returning");
  });

  it("renders a failed run with the error as the last row", () => {
    const failed = report({
      status: "failed",
      exit: undefined,
      notReached: [],
      error: { name: "Error", message: "template props missing: plan" },
      steps: [
        { kind: "enrolled", at: start, event: "trial.started", properties: {} },
        { kind: "failed", at: start, error: "template props missing: plan" },
      ],
    });
    expect(formatMarkdown([failed])).toContain(
      "| +0m | Failed | template props missing: plan |",
    );
  });
});

describe("formatText", () => {
  it("renders aligned plain text without color codes by default", () => {
    const output = formatText([report()]);
    expect(output.includes("\u001b[")).toBe(false);
    const lines = output.split("\n");
    expect(lines.slice(0, 3)).toEqual([
      "trial-upgrade · converts",
      "2 emails (1 blocked) over 9 days; exits on subscription.created.",
      "user u1 <ada@example.com> · starts 2026-03-02 09:00 UTC",
    ]);
    expect(lines).toContain(
      "  +0m     Wait for event  await-project: project.created up to 2d → timed out at +2d",
    );
    expect(lines).toContain(
      "  +9d     Exited          subscription.created (exitOn)",
    );
    expect(lines.at(-1)).toBe(
      "Not reached (the run ended first): feature.used at +12d.",
    );
  });

  it("adds ANSI colors when asked", () => {
    expect(formatText([report()], { color: true }).includes("\u001b[")).toBe(
      true,
    );
  });
});
