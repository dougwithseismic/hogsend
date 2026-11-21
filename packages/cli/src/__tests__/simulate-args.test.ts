import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildRuns,
  listScenarioFiles,
  parseDuration,
  parseEventSpec,
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
});

describe("parseSimulateArgs", () => {
  it("defaults to text output and no events", () => {
    expect(parseSimulateArgs(["welcome"])).toEqual({
      journeyId: "welcome",
      events: [],
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
      now: "2026-03-02T09:00:00Z",
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
      /invalid --now/,
    );
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
        now: "2026-03-02T09:00:00.000Z",
        timezone: "Europe/London",
        events: [
          { after: "1d", event: "project.created" },
          { at: "2026-03-09T09:00:00.000Z", event: "subscription.created" },
          { after: { hours: 2 }, event: "x", properties: { a: 1 } },
        ],
        guard: [{ after: "3d", subscribed: false }],
        subscribed: true,
        smsConsent: "granted",
        preferences: { categories: { marketing: false } },
        history: { events: [] },
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
        history: { events: [] },
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
    expect(buildRuns(base, [])).toEqual([
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
        },
      },
    ]);
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
        now: "2026-04-01T00:00:00Z",
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
