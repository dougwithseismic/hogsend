import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildRuns,
  listScenarioFiles,
  parseDuration,
  parseEventSpec,
  parseIsoDate,
  parseScenarioFile,
  parseSimulateArgs,
  readScenarioFile,
} from "../lib/simulate-args.js";

describe("parseDuration", () => {
  it("parses single units into the harness duration shape", () => {
    expect(parseDuration("30m")).toEqual({ minutes: 30 });
    expect(parseDuration("6h")).toEqual({ hours: 6 });
    expect(parseDuration("2d")).toEqual({ hours: 48 });
    expect(parseDuration("1w")).toEqual({ hours: 168 });
    expect(parseDuration("45s")).toEqual({ seconds: 45 });
  });

  it("parses compounds, decimals, a leading + and zero", () => {
    expect(parseDuration("1d12h")).toEqual({ hours: 36 });
    expect(parseDuration("2h30m")).toEqual({ hours: 2, minutes: 30 });
    expect(parseDuration("1.5d")).toEqual({ hours: 36 });
    expect(parseDuration("+3d")).toEqual({ hours: 72 });
    expect(parseDuration(" 6h ")).toEqual({ hours: 6 });
    expect(parseDuration("0")).toEqual({});
  });

  it("rejects anything else", () => {
    for (const input of ["", "2", "2x", "d", "2d junk", "two days", "-1d"]) {
      expect(() => parseDuration(input), input).toThrow(/invalid duration/);
    }
  });
});

describe("parseEventSpec", () => {
  it("parses <after>:<event>", () => {
    expect(parseEventSpec("2d:project.created")).toEqual({
      event: "project.created",
      after: { hours: 48 },
    });
  });

  it("parses JSON properties after a third colon", () => {
    expect(
      parseEventSpec('6h:subscription.created:{"plan":"pro","seats":3}'),
    ).toEqual({
      event: "subscription.created",
      after: { hours: 6 },
      properties: { plan: "pro", seats: 3 },
    });
  });

  it("keeps colons that belong to the event name", () => {
    expect(parseEventSpec("30m:stripe:invoice.paid")).toEqual({
      event: "stripe:invoice.paid",
      after: { minutes: 30 },
    });
    expect(parseEventSpec('1d:stripe:invoice.paid:{"amount":10}')).toEqual({
      event: "stripe:invoice.paid",
      after: { hours: 24 },
      properties: { amount: 10 },
    });
  });

  it("explains malformed specs", () => {
    expect(() => parseEventSpec("project.created")).toThrow(
      /expected "<after>:<event>/,
    );
    expect(() => parseEventSpec("soon:project.created")).toThrow(
      /invalid duration "soon"/,
    );
    expect(() => parseEventSpec(":project.created")).toThrow(
      /expected "<after>:<event>/,
    );
    expect(() => parseEventSpec("2d:")).toThrow(/missing event name/);
    expect(() => parseEventSpec("2d:x:{nope}")).toThrow(/invalid JSON/);
  });

  it("allows whitespace before the properties object", () => {
    expect(parseEventSpec('2d:evt: {"a":1}')).toEqual({
      event: "evt",
      after: { hours: 48 },
      properties: { a: 1 },
    });
    expect(parseEventSpec('2d:stripe:invoice.paid :  {"a":1} ')).toEqual({
      event: "stripe:invoice.paid",
      after: { hours: 48 },
      properties: { a: 1 },
    });
  });

  it("rejects event names with whitespace, braces or brackets", () => {
    for (const spec of [
      "2d:evt:[1,2]",
      "2d:project created",
      "2d:evt}",
      '2d:evt {"a":1}',
    ]) {
      expect(() => parseEventSpec(spec), spec).toThrow(
        /contains whitespace, a brace or a bracket/,
      );
    }
  });
});

describe("parseIsoDate", () => {
  it("normalizes ISO 8601 dates and date-times to UTC", () => {
    expect(parseIsoDate("2026-03-02T09:00:00Z", "x")).toBe(
      "2026-03-02T09:00:00.000Z",
    );
    expect(parseIsoDate("2026-03-02T09:00:00.250+01:00", "x")).toBe(
      "2026-03-02T08:00:00.250Z",
    );
    expect(parseIsoDate("2026-03-02T09:00-0130", "x")).toBe(
      "2026-03-02T10:30:00.000Z",
    );
  });

  it("reads input without an offset as UTC", () => {
    expect(parseIsoDate("2026-03-02T09:00", "x")).toBe(
      "2026-03-02T09:00:00.000Z",
    );
    expect(parseIsoDate("2026-03-02T09:00:30", "x")).toBe(
      "2026-03-02T09:00:30.000Z",
    );
    expect(parseIsoDate("2026-03-02", "x")).toBe("2026-03-02T00:00:00.000Z");
  });

  it("rejects anything that is not an ISO 8601 date", () => {
    for (const input of [
      "soon",
      "March 2 2026",
      "2026/03/02",
      "2026-3-2",
      "2026-02-30",
      "2026-13-01",
      "2026-03-02T24:00:00Z",
      "2026-03-02 09:00",
      "1700000000000",
    ]) {
      expect(() => parseIsoDate(input, "--now"), input).toThrow(
        /--now: invalid date .*ISO 8601/,
      );
    }
  });
});

describe("parseSimulateArgs", () => {
  it("defaults to text output, no events and a 60s timeout", () => {
    expect(parseSimulateArgs(["welcome"])).toEqual({
      journeyId: "welcome",
      events: [],
      timeoutMs: 60_000,
      format: "text",
      templates: true,
      force: false,
      help: false,
    });
  });

  it("parses every flag", () => {
    const args = parseSimulateArgs([
      "welcome",
      "--user",
      '{"id":"u1","properties":{"plan":"pro"}}',
      "--email",
      "ada@example.com",
      "--event",
      "1d:a",
      "--event",
      "2d:b",
      "--now",
      "2026-03-02T09:00:00Z",
      "--until",
      "90d",
      "--timeout",
      "2.5",
      "--format",
      "markdown",
      "--cwd",
      "apps/api",
      "--journeys",
      "src/j.ts",
      "--no-templates",
      "--force",
    ]);
    expect(args).toMatchObject({
      journeyId: "welcome",
      user: { id: "u1", properties: { plan: "pro" } },
      email: "ada@example.com",
      events: [
        { event: "a", after: { hours: 24 } },
        { event: "b", after: { hours: 48 } },
      ],
      now: "2026-03-02T09:00:00.000Z",
      until: { hours: 2160 },
      timeoutMs: 2500,
      format: "markdown",
      cwd: "apps/api",
      journeys: "src/j.ts",
      templates: false,
      force: true,
    });
  });

  it("rejects bad input with a readable message", () => {
    expect(() => parseSimulateArgs(["a", "b"])).toThrow(/one journey id/);
    expect(() => parseSimulateArgs(["a", "--format", "html"])).toThrow(
      /invalid --format "html"/,
    );
    expect(() =>
      parseSimulateArgs(["--scenario", "a.json", "--all-scenarios", "dir"]),
    ).toThrow(/either --scenario or --all-scenarios/);
    expect(() => parseSimulateArgs(["a", "--now", "soon"])).toThrow(
      /--now: invalid date "soon"/,
    );
    expect(() => parseSimulateArgs(["a", "--now", "March 2"])).toThrow(
      /--now: invalid date/,
    );
    expect(() => parseSimulateArgs(["a", "--until", "0"])).toThrow(
      /--until: must be a duration greater than 0/,
    );
    expect(() => parseSimulateArgs(["a", "--until", "later"])).toThrow(
      /invalid duration "later"/,
    );
    for (const timeout of ["0", "-1", "soon"]) {
      expect(() => parseSimulateArgs(["a", `--timeout=${timeout}`])).toThrow(
        /invalid --timeout/,
      );
    }
    expect(() => parseSimulateArgs(["a", "--user", "{"])).toThrow(
      /--user: invalid JSON/,
    );
    expect(() => parseSimulateArgs(["a", "--user", '{"name":"x"}'])).toThrow(
      /unknown key "name"/,
    );
    expect(() => parseSimulateArgs(["a", "--bogus"])).toThrow();
  });
});

describe("parseScenarioFile", () => {
  it("accepts the documented shape and converts durations", () => {
    const file = parseScenarioFile(
      {
        $schema: "ignored",
        name: "converts",
        description: "Trial user who upgrades",
        journey: "trial-upgrade",
        user: { id: "u1", email: "a@example.com", properties: { plan: "x" } },
        now: "2026-03-02T09:00:00",
        until: "60d",
        timezone: "Europe/London",
        events: [
          { after: "1d", event: "project.created" },
          { at: "2026-03-09T10:00:00+01:00", event: "subscription.created" },
          { after: { hours: 2 }, event: "x", properties: { a: 1 } },
        ],
        guard: [{ after: "3d", subscribed: false }],
        subscribed: true,
        smsConsent: "granted",
        preferences: { categories: { marketing: false } },
        history: {
          events: [
            {
              event: "feature.used",
              userId: "u1",
              properties: {},
              occurredAt: "2026-02-01",
            },
          ],
          journeys: [
            { userId: "u1", journeyId: "j", completedAt: "2026-01-01T00:00" },
          ],
        },
        entry: { activeJourneyIds: [] },
        variants: { "welcome-subject": "short" },
      },
      "converts.json",
    );
    expect(file).toEqual({
      journey: "trial-upgrade",
      scenario: {
        name: "converts",
        user: { id: "u1", email: "a@example.com", properties: { plan: "x" } },
        now: "2026-03-02T09:00:00.000Z",
        until: { hours: 1440 },
        timezone: "Europe/London",
        events: [
          { after: { hours: 24 }, event: "project.created" },
          { at: "2026-03-09T09:00:00.000Z", event: "subscription.created" },
          { after: { hours: 2 }, event: "x", properties: { a: 1 } },
        ],
        guard: [{ after: { hours: 72 }, subscribed: false }],
        subscribed: true,
        smsConsent: "granted",
        preferences: { categories: { marketing: false } },
        history: {
          events: [
            {
              event: "feature.used",
              userId: "u1",
              properties: {},
              occurredAt: "2026-02-01T00:00:00.000Z",
            },
          ],
          journeys: [
            {
              userId: "u1",
              journeyId: "j",
              completedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
        entry: { activeJourneyIds: [] },
        variants: { "welcome-subject": "short" },
      },
    });
  });

  it("names the scenario after the file when it has no name", () => {
    expect(parseScenarioFile({}, "/tmp/scenarios/lapses.json")).toEqual({
      scenario: { name: "lapses" },
    });
  });

  it("rejects typos and malformed fields", () => {
    const bad: Array<[unknown, RegExp]> = [
      [[], /expected a JSON object/],
      [{ event: [] }, /unknown key "event"/],
      [{ events: {} }, /"events" must be an array/],
      [{ events: [{ after: "1d" }] }, /"event" must be a non-empty string/],
      [{ events: [{ event: "x", when: "1d" }] }, /unknown key "when"/],
      [
        { events: [{ event: "x", after: "1d", at: "2026-01-01" }] },
        /either "after" or "at"/,
      ],
      [
        { events: [{ event: "x", after: { days: 2 } }] },
        /unknown duration key/,
      ],
      [{ events: [{ event: "x", after: "soon" }] }, /invalid duration/],
      [{ guard: [{ after: "1d" }] }, /"subscribed" must be true or false/],
      [{ smsConsent: "yes" }, /"smsConsent" must be one of/],
      [{ user: { id: "" } }, /"id" must be a non-empty string/],
      [{ user: { properties: { a: {} } } }, /property "a" must be/],
      [{ history: [] }, /"history" must be an object/],
      [{ now: "next tuesday" }, /^s\.json "now": invalid date "next tuesday"/],
      [{ until: "0" }, /s\.json "until": must be a duration greater than 0/],
      [
        { events: [{ event: "x", at: "2026-02-30" }] },
        /s\.json events\[0\] "at": invalid date/,
      ],
      [
        { guard: [{ subscribed: false, at: "tomorrow" }] },
        /s\.json guard\[0\] "at": invalid date/,
      ],
      [
        { history: { events: [{ event: "x", occurredAt: "last week" }] } },
        /s\.json "history" events\[0\] "occurredAt": invalid date/,
      ],
      [
        { history: { emails: [{ email: "a@b.co", template: "t" }] } },
        /s\.json "history" emails\[0\]: "sentAt" is required/,
      ],
      [
        { history: { sms: [{ phone: "1", template: "t", sentAt: 5 }] } },
        /"sentAt" must be an ISO date string/,
      ],
      [
        { history: { journeys: [{ journeyId: "j", enteredAt: "x" }] } },
        /s\.json "history" journeys\[0\] "enteredAt": invalid date/,
      ],
      [{ history: { emailz: [] } }, /"history": unknown key "emailz"/],
    ];
    for (const [raw, message] of bad) {
      expect(() => parseScenarioFile(raw, "s.json"), String(message)).toThrow(
        message,
      );
    }
  });
});

describe("scenario files on disk", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("reads one file and lists a directory in name order", () => {
    dir = mkdtempSync(join(tmpdir(), "simulate-args-"));
    writeFileSync(join(dir, "b.json"), '{"name":"second"}');
    writeFileSync(join(dir, "a.json"), '{"name":"first"}');
    writeFileSync(join(dir, "notes.txt"), "ignored");
    expect(listScenarioFiles(dir)).toEqual([
      join(dir, "a.json"),
      join(dir, "b.json"),
    ]);
    expect(readScenarioFile(join(dir, "a.json")).scenario.name).toBe("first");

    writeFileSync(join(dir, "broken.json"), "{");
    expect(() => readScenarioFile(join(dir as string, "broken.json"))).toThrow(
      /invalid JSON/,
    );
    expect(() => readScenarioFile(join(dir as string, "missing.json"))).toThrow(
      /scenario file not found/,
    );
  });

  it("fails on a directory with no scenarios", () => {
    dir = mkdtempSync(join(tmpdir(), "simulate-args-"));
    expect(() => listScenarioFiles(dir as string)).toThrow(/no \*\.json/);
    expect(() => listScenarioFiles(join(dir as string, "nope"))).toThrow(
      /scenario directory not found/,
    );
  });
});

describe("buildRuns", () => {
  const base = parseSimulateArgs(["welcome"]);

  it("builds one run from flags alone, with the default user", () => {
    const clock = new Date("2026-11-22T10:15:00.000Z");
    expect(buildRuns(base, [], clock)).toEqual([
      {
        journeyId: "welcome",
        source: "command line",
        scenario: {
          name: "command line",
          user: {
            id: "sim-user",
            email: "sim-user@example.com",
            properties: {},
          },
          now: "2026-11-22T10:15:00.000Z",
        },
      },
    ]);
  });

  it("starts at the current time unless --now or the file sets one", () => {
    const before = Date.now();
    const [run] = buildRuns(base, []);
    const started = Date.parse(run?.scenario.now as string);
    expect(started).toBeGreaterThanOrEqual(before);
    expect(started).toBeLessThanOrEqual(Date.now());

    const file = parseScenarioFile(
      { now: "2026-03-02T09:00:00Z", until: "10d" },
      "s.json",
    );
    const [fromFile] = buildRuns(base, [{ path: "s.json", file }]);
    expect(fromFile?.scenario).toMatchObject({
      now: "2026-03-02T09:00:00.000Z",
      until: { hours: 240 },
    });
    const flags = parseSimulateArgs(["welcome", "--until", "2d"]);
    const [fromFlag] = buildRuns(flags, [{ path: "s.json", file }]);
    expect(fromFlag?.scenario.until).toEqual({ hours: 48 });
  });

  it("layers flags over a scenario file", () => {
    const args = parseSimulateArgs([
      "--user",
      '{"email":"flag@example.com","properties":{"seats":3}}',
      "--user-id",
      "u-flag",
      "--event",
      "5d:late.event",
      "--now",
      "2026-04-01T00:00:00Z",
    ]);
    const file = parseScenarioFile(
      {
        journey: "welcome",
        user: { id: "u-file", email: "file@example.com", properties: { a: 1 } },
        now: "2026-03-02T09:00:00.000Z",
        events: [{ after: "1d", event: "early.event" }],
      },
      "s.json",
    );
    const [run] = buildRuns(args, [{ path: "s.json", file }]);
    expect(run).toEqual({
      journeyId: "welcome",
      source: "s.json",
      scenario: {
        name: "s",
        user: {
          id: "u-flag",
          email: "flag@example.com",
          properties: { a: 1, seats: 3 },
        },
        now: "2026-04-01T00:00:00.000Z",
        events: [
          { after: { hours: 24 }, event: "early.event" },
          { after: { hours: 120 }, event: "late.event" },
        ],
      },
    });
  });

  it("requires a journey and refuses a mismatched one", () => {
    const noId = parseSimulateArgs([]);
    expect(() => buildRuns(noId, [])).toThrow(/missing journey id/);
    expect(() =>
      buildRuns(noId, [{ path: "s.json", file: { scenario: { name: "s" } } }]),
    ).toThrow(/s\.json: no journey to run/);
    expect(() =>
      buildRuns(base, [
        { path: "s.json", file: { journey: "other", scenario: { name: "s" } } },
      ]),
    ).toThrow(/s\.json is for journey "other", not "welcome"/);
  });
});
