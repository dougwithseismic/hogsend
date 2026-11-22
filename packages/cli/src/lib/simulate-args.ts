import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import type {
  JourneyScenario,
  ScenarioEvent,
  ScenarioGuardChange,
  TestJourneyUser,
} from "@hogsend/testing";

/**
 * Pure input handling for `hogsend simulate`: flag parsing, the duration and
 * `--event` shorthands, and scenario-file validation. Everything here throws a
 * plain `Error` with a message fit to show the user.
 */

export type SimulateFormat = "text" | "markdown" | "json";

type Duration = NonNullable<ScenarioEvent["after"]>;

/**
 * The JSON-serializable part of `JourneyScenario` from `@hogsend/testing`.
 * `setup`, `templates` and `smsTemplates` are code, so they are not part of a
 * scenario file (templates are loaded from the app instead).
 */
export type ScenarioData = Omit<
  JourneyScenario,
  "setup" | "templates" | "smsTemplates"
>;

/** One journey run to simulate: the journey id plus a scenario. */
export interface SimulationRun {
  journeyId: string;
  scenario: ScenarioData;
  /** Where the scenario came from, for error messages. */
  source: string;
}

export interface SimulateArgs {
  journeyId?: string;
  user?: Partial<TestJourneyUser>;
  userId?: string;
  email?: string;
  events: ScenarioEvent[];
  now?: string;
  /** Virtual-time horizon; the harness default (720h) applies when unset. */
  until?: Duration;
  /** Wall-clock limit for the simulation child, in milliseconds. */
  timeoutMs: number;
  scenario?: string;
  allScenarios?: string;
  format: SimulateFormat;
  cwd?: string;
  journeys?: string;
  templates: boolean;
  force: boolean;
  help: boolean;
}

export const DEFAULT_USER: TestJourneyUser = {
  id: "sim-user",
  email: "sim-user@example.com",
  properties: {},
};

/** Default wall-clock limit for one `hogsend simulate` invocation. */
export const DEFAULT_TIMEOUT_SECONDS = 60;

const ISO_DATE =
  /^(\d{4})-(\d{2})-(\d{2})(?:T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d+)?)?(Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)?)?$/i;

/**
 * Parse an ISO 8601 date (`2026-03-02`) or date-time
 * (`2026-03-02T09:00`, `2026-03-02T09:00:00.000+01:00`) into a normalized UTC
 * ISO string. Input without an offset is read as UTC, never as the machine's
 * local time, so a run gives the same result on every machine. Anything else
 * (`March 2`, `2026/03/02`, an impossible date such as `2026-02-30`) throws.
 */
export function parseIsoDate(value: string, label: string): string {
  const fail = (): never => {
    throw new Error(
      `${label}: invalid date "${value}" (use an ISO 8601 date or date-time, e.g. 2026-03-02T09:00:00Z; no offset means UTC)`,
    );
  };
  const text = value.trim();
  const match = ISO_DATE.exec(text);
  if (!match) return fail();
  const [, year, month, day, hour, , , offset] = match;
  const probe = new Date(
    Date.UTC(Number(year), Number(month) - 1, Number(day)),
  );
  if (
    probe.getUTCFullYear() !== Number(year) ||
    probe.getUTCMonth() !== Number(month) - 1 ||
    probe.getUTCDate() !== Number(day)
  ) {
    return fail();
  }
  let normalized = text.toUpperCase();
  if (hour === undefined) normalized += "T00:00:00Z";
  else if (offset === undefined) normalized += "Z";
  else if (/^[+-]\d{4}$/.test(offset)) {
    normalized = `${normalized.slice(0, -2)}:${normalized.slice(-2)}`;
  }
  const ms = Date.parse(normalized);
  if (Number.isNaN(ms)) return fail();
  return new Date(ms).toISOString();
}

const UNIT_HOURS: Record<string, number> = { w: 168, d: 24, h: 1 };

/**
 * Parse a duration shorthand into the harness's `{ hours, minutes, seconds }`
 * shape. Accepts `30m`, `6h`, `2d`, `1w`, `45s`, compounds such as `1d12h`,
 * an optional leading `+`, and `0` for "immediately".
 */
export function parseDuration(input: string): Duration {
  const text = input.trim().replace(/^\+/, "");
  if (text === "0") return {};
  const pattern = /(\d+(?:\.\d+)?)(w|d|h|m|s)/gy;
  let hours = 0;
  let minutes = 0;
  let seconds = 0;
  let consumed = 0;
  for (const match of text.matchAll(pattern)) {
    const amount = Number(match[1]);
    const unit = match[2] as string;
    if (unit === "m") minutes += amount;
    else if (unit === "s") seconds += amount;
    else hours += amount * (UNIT_HOURS[unit] ?? 0);
    consumed += match[0].length;
  }
  if (text.length === 0 || consumed !== text.length) {
    throw new Error(
      `invalid duration "${input}" (use forms like 30m, 6h, 2d, 1w or 1d12h)`,
    );
  }
  return {
    ...(hours ? { hours } : {}),
    ...(minutes ? { minutes } : {}),
    ...(seconds ? { seconds } : {}),
  };
}

/** A duration from a scenario file: shorthand string or harness object. */
function parseDurationValue(value: unknown, label: string): Duration {
  if (typeof value === "string") return parseDuration(value);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const out: Record<string, number> = {};
    for (const [key, amount] of Object.entries(value)) {
      if (!["hours", "minutes", "seconds"].includes(key)) {
        throw new Error(
          `${label}: unknown duration key "${key}" (use hours, minutes, seconds, or a string like "2d")`,
        );
      }
      if (typeof amount !== "number" || !Number.isFinite(amount)) {
        throw new Error(`${label}: "${key}" must be a number`);
      }
      out[key] = amount;
    }
    return out as Duration;
  }
  throw new Error(`${label}: expected a duration like "2d" or { "hours": 48 }`);
}

/** Reject a zero or negative duration where one would make no sense. */
function parsePositiveDuration(value: Duration, label: string): Duration {
  const ms =
    ((value.hours ?? 0) * 3600 +
      (value.minutes ?? 0) * 60 +
      (value.seconds ?? 0)) *
    1000;
  if (!(ms > 0)) {
    throw new Error(`${label}: must be a duration greater than 0 (e.g. 90d)`);
  }
  return value;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

function parseJsonObject(text: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${label}: invalid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (!isRecord(parsed)) throw new Error(`${label}: expected a JSON object`);
  return parsed;
}

/**
 * Parse `--event "<after>:<event>[:<json props>]"`. Event names may contain
 * colons; the properties part is recognised by its opening `{`, which may
 * follow whitespace (`2d:evt: {"a":1}`). Event names with whitespace, braces
 * or brackets are rejected rather than guessed at; put those in a scenario
 * file.
 */
export function parseEventSpec(spec: string): ScenarioEvent {
  const first = spec.indexOf(":");
  if (first <= 0) {
    throw new Error(
      `invalid --event "${spec}" (expected "<after>:<event>[:<json props>]", e.g. "2d:project.created")`,
    );
  }
  const after = parseDuration(spec.slice(0, first));
  const rest = spec.slice(first + 1);
  const propsMatch = /:\s*\{/.exec(rest);
  const event = (propsMatch ? rest.slice(0, propsMatch.index) : rest).trim();
  if (!event) throw new Error(`invalid --event "${spec}": missing event name`);
  if (/[\s{}[\]]/.test(event)) {
    throw new Error(
      `invalid --event "${spec}": event name "${event}" contains whitespace, a brace or a bracket (properties must be a JSON object after a colon, e.g. "2d:project.created:{"plan":"pro"}"; use a scenario file for other event names)`,
    );
  }
  const properties = propsMatch
    ? parseJsonObject(
        rest.slice(propsMatch.index + 1).trim(),
        `--event "${spec}"`,
      )
    : undefined;
  return { event, after, ...(properties ? { properties } : {}) };
}

function parseUser(value: unknown, label: string): Partial<TestJourneyUser> {
  if (!isRecord(value)) throw new Error(`${label}: expected an object`);
  const user: Partial<TestJourneyUser> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "id" || key === "email") {
      if (typeof item !== "string" || !item) {
        throw new Error(`${label}: "${key}" must be a non-empty string`);
      }
      user[key] = item;
    } else if (key === "properties") {
      if (!isRecord(item)) {
        throw new Error(`${label}: "properties" must be an object`);
      }
      for (const [prop, propValue] of Object.entries(item)) {
        if (
          propValue !== null &&
          !["string", "number", "boolean"].includes(typeof propValue)
        ) {
          throw new Error(
            `${label}: property "${prop}" must be a string, number, boolean or null`,
          );
        }
      }
      user.properties = item as TestJourneyUser["properties"];
    } else {
      throw new Error(
        `${label}: unknown key "${key}" (allowed: id, email, properties)`,
      );
    }
  }
  return user;
}

function parseTimed<T extends { after?: Duration; at?: string }>(
  value: Record<string, unknown>,
  label: string,
  out: T,
): T {
  if (value.after !== undefined && value.at !== undefined) {
    throw new Error(`${label}: use either "after" or "at", not both`);
  }
  if (value.after !== undefined) {
    out.after = parseDurationValue(value.after, `${label} "after"`);
  }
  if (value.at !== undefined) {
    if (typeof value.at !== "string") {
      throw new Error(`${label}: "at" must be an ISO date string`);
    }
    out.at = parseIsoDate(value.at, `${label} "at"`);
  }
  return out;
}

/** History fixture lists and the date fields each entry may carry. */
const HISTORY_DATES: Record<
  string,
  { required: string[]; optional: string[] }
> = {
  events: { required: ["occurredAt"], optional: [] },
  emails: { required: ["sentAt"], optional: [] },
  sms: { required: ["sentAt"], optional: [] },
  journeys: { required: [], optional: ["completedAt", "enteredAt"] },
};

/**
 * Check the dates in a `history` fixture and normalize them to UTC ISO
 * strings, so a typo fails here with the file name rather than later inside
 * the harness.
 */
function parseHistory(
  value: Record<string, unknown>,
  label: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...value };
  for (const [key, list] of Object.entries(value)) {
    const dates = HISTORY_DATES[key];
    if (!dates) {
      throw new Error(
        `${label}: unknown key "${key}" (allowed: ${Object.keys(HISTORY_DATES).join(", ")})`,
      );
    }
    if (!Array.isArray(list)) {
      throw new Error(`${label}: "${key}" must be an array`);
    }
    out[key] = list.map((item, index) => {
      const itemLabel = `${label} ${key}[${index}]`;
      if (!isRecord(item)) throw new Error(`${itemLabel}: expected an object`);
      const copy: Record<string, unknown> = { ...item };
      for (const field of [...dates.required, ...dates.optional]) {
        const date = item[field];
        if (date === undefined) {
          if (dates.required.includes(field)) {
            throw new Error(`${itemLabel}: "${field}" is required`);
          }
          continue;
        }
        if (typeof date !== "string") {
          throw new Error(
            `${itemLabel}: "${field}" must be an ISO date string`,
          );
        }
        copy[field] = parseIsoDate(date, `${itemLabel} "${field}"`);
      }
      return copy;
    });
  }
  return out;
}

function parseScenarioEvent(value: unknown, label: string): ScenarioEvent {
  if (!isRecord(value)) throw new Error(`${label}: expected an object`);
  const allowed = ["event", "after", "at", "properties", "userId", "userEmail"];
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new Error(
        `${label}: unknown key "${key}" (allowed: ${allowed.join(", ")})`,
      );
    }
  }
  if (typeof value.event !== "string" || !value.event) {
    throw new Error(`${label}: "event" must be a non-empty string`);
  }
  const event: ScenarioEvent & { at?: string } = { event: value.event };
  if (value.properties !== undefined) {
    if (!isRecord(value.properties)) {
      throw new Error(`${label}: "properties" must be an object`);
    }
    event.properties = value.properties;
  }
  for (const key of ["userId", "userEmail"] as const) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== "string") {
        throw new Error(`${label}: "${key}" must be a string`);
      }
      event[key] = value[key] as string;
    }
  }
  return parseTimed(value, label, event);
}

function parseGuardChange(value: unknown, label: string): ScenarioGuardChange {
  if (!isRecord(value)) throw new Error(`${label}: expected an object`);
  for (const key of Object.keys(value)) {
    if (!["subscribed", "after", "at"].includes(key)) {
      throw new Error(
        `${label}: unknown key "${key}" (allowed: subscribed, after, at)`,
      );
    }
  }
  if (typeof value.subscribed !== "boolean") {
    throw new Error(`${label}: "subscribed" must be true or false`);
  }
  return parseTimed(value, label, {
    subscribed: value.subscribed,
  } as ScenarioGuardChange & { at?: string });
}

const SMS_CONSENT = ["granted", "missing", "opted_out", "suppressed"];

/** A scenario file: `ScenarioData` plus optional `journey` and `description`. */
export interface ScenarioFile {
  journey?: string;
  scenario: Partial<ScenarioData> & { name: string };
}

/**
 * Validate a parsed scenario file. Unknown keys are rejected so a typo (for
 * example `event` instead of `events`) fails loudly instead of being ignored.
 */
export function parseScenarioFile(raw: unknown, source: string): ScenarioFile {
  if (!isRecord(raw)) throw new Error(`${source}: expected a JSON object`);
  const passthrough = ["preferences", "history", "entry", "variants"] as const;
  const allowed = [
    "$schema",
    "name",
    "description",
    "journey",
    "user",
    "now",
    "until",
    "timezone",
    "events",
    "guard",
    "subscribed",
    "smsConsent",
    "connectorActions",
    ...passthrough,
  ];
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      throw new Error(
        `${source}: unknown key "${key}" (allowed: ${allowed
          .filter((item) => item !== "$schema")
          .join(", ")})`,
      );
    }
  }
  const stringField = (key: string): string | undefined => {
    const value = raw[key];
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !value) {
      throw new Error(`${source}: "${key}" must be a non-empty string`);
    }
    return value;
  };

  const scenario: Partial<ScenarioData> & { name: string } = {
    name: stringField("name") ?? basename(source).replace(/\.json$/i, ""),
  };
  stringField("description");
  const journey = stringField("journey");
  const now = stringField("now");
  if (now) scenario.now = parseIsoDate(now, `${source} "now"`);
  if (raw.until !== undefined) {
    scenario.until = parsePositiveDuration(
      parseDurationValue(raw.until, `${source} "until"`),
      `${source} "until"`,
    );
  }
  const timezone = stringField("timezone");
  if (timezone) scenario.timezone = timezone;
  if (raw.user !== undefined) {
    scenario.user = parseUser(raw.user, `${source} "user"`) as TestJourneyUser;
  }
  if (raw.events !== undefined) {
    if (!Array.isArray(raw.events)) {
      throw new Error(`${source}: "events" must be an array`);
    }
    scenario.events = raw.events.map((event, index) =>
      parseScenarioEvent(event, `${source} events[${index}]`),
    );
  }
  if (raw.guard !== undefined) {
    if (!Array.isArray(raw.guard)) {
      throw new Error(`${source}: "guard" must be an array`);
    }
    scenario.guard = raw.guard.map((change, index) =>
      parseGuardChange(change, `${source} guard[${index}]`),
    );
  }
  if (raw.subscribed !== undefined) {
    if (typeof raw.subscribed !== "boolean") {
      throw new Error(`${source}: "subscribed" must be true or false`);
    }
    scenario.subscribed = raw.subscribed;
  }
  if (raw.smsConsent !== undefined) {
    if (
      typeof raw.smsConsent !== "string" ||
      !SMS_CONSENT.includes(raw.smsConsent)
    ) {
      throw new Error(
        `${source}: "smsConsent" must be one of ${SMS_CONSENT.join(", ")}`,
      );
    }
    scenario.smsConsent = raw.smsConsent as ScenarioData["smsConsent"];
  }
  if (raw.connectorActions !== undefined) {
    if (!Array.isArray(raw.connectorActions)) {
      throw new Error(`${source}: "connectorActions" must be an array`);
    }
    scenario.connectorActions =
      raw.connectorActions as ScenarioData["connectorActions"];
  }
  for (const key of passthrough) {
    const value = raw[key];
    if (value === undefined) continue;
    if (!isRecord(value)) {
      throw new Error(`${source}: "${key}" must be an object`);
    }
    Object.assign(scenario, {
      [key]:
        key === "history" ? parseHistory(value, `${source} "history"`) : value,
    });
  }
  return { ...(journey ? { journey } : {}), scenario };
}

/** Read and validate one scenario file. */
export function readScenarioFile(path: string): ScenarioFile {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`scenario file not found: ${path}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${path}: invalid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  return parseScenarioFile(raw, path);
}

/** Every `*.json` file directly inside `dir`, sorted by name. */
export function listScenarioFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    throw new Error(`scenario directory not found: ${dir}`);
  }
  const files = entries
    .filter((name) => name.toLowerCase().endsWith(".json"))
    .sort()
    .map((name) => join(dir, name));
  if (files.length === 0) throw new Error(`no *.json scenarios in ${dir}`);
  return files;
}

/** Parse the command's argv (after the `simulate` token). */
export function parseSimulateArgs(argv: string[]): SimulateArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      user: { type: "string" },
      "user-id": { type: "string" },
      email: { type: "string" },
      event: { type: "string", multiple: true },
      now: { type: "string" },
      until: { type: "string" },
      timeout: { type: "string" },
      scenario: { type: "string" },
      "all-scenarios": { type: "string" },
      format: { type: "string" },
      cwd: { type: "string" },
      journeys: { type: "string" },
      "no-templates": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (positionals.length > 1) {
    throw new Error(
      `expected one journey id, got ${positionals.length}: ${positionals.join(" ")}`,
    );
  }
  const format = values.format ?? "text";
  if (format !== "text" && format !== "markdown" && format !== "json") {
    throw new Error(
      `invalid --format "${format}" (use text, markdown or json)`,
    );
  }
  if (values.scenario && values["all-scenarios"]) {
    throw new Error("use either --scenario or --all-scenarios, not both");
  }
  const now =
    values.now !== undefined ? parseIsoDate(values.now, "--now") : undefined;
  const until =
    values.until !== undefined
      ? parsePositiveDuration(parseDuration(values.until), "--until")
      : undefined;
  let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;
  if (values.timeout !== undefined) {
    timeoutSeconds = Number(values.timeout);
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
      throw new Error(
        `invalid --timeout "${values.timeout}" (use a number of seconds greater than 0)`,
      );
    }
  }
  return {
    ...(positionals[0] ? { journeyId: positionals[0] } : {}),
    ...(values.user !== undefined
      ? {
          user: parseUser(parseJsonObject(values.user, "--user"), "--user"),
        }
      : {}),
    ...(values["user-id"] !== undefined ? { userId: values["user-id"] } : {}),
    ...(values.email !== undefined ? { email: values.email } : {}),
    events: (values.event ?? []).map(parseEventSpec),
    ...(now !== undefined ? { now } : {}),
    ...(until !== undefined ? { until } : {}),
    timeoutMs: Math.round(timeoutSeconds * 1000),
    ...(values.scenario !== undefined ? { scenario: values.scenario } : {}),
    ...(values["all-scenarios"] !== undefined
      ? { allScenarios: values["all-scenarios"] }
      : {}),
    format,
    ...(values.cwd !== undefined ? { cwd: values.cwd } : {}),
    ...(values.journeys !== undefined ? { journeys: values.journeys } : {}),
    templates: !values["no-templates"],
    force: values.force ?? false,
    help: values.help ?? false,
  };
}

/**
 * Combine scenario files with the command-line inputs into concrete runs.
 * Flags layer over every scenario: `--user` merges into the file's user
 * (properties merge shallowly), `--user-id`/`--email` win, `--event`s are
 * appended, and `--now`/`--until` replace the file's values. With neither
 * `--now` nor a file `now`, the run starts at `clock` (the current time).
 * With no files, the flags alone describe one run.
 */
export function buildRuns(
  args: SimulateArgs,
  files: Array<{ path: string; file: ScenarioFile }>,
  clock: Date = new Date(),
): SimulationRun[] {
  const inputs =
    files.length > 0
      ? files
      : [
          {
            path: "command line",
            file: { scenario: { name: "command line" } } as ScenarioFile,
          },
        ];
  return inputs.map(({ path, file }) => {
    const journeyId = args.journeyId ?? file.journey;
    if (!journeyId) {
      throw new Error(
        files.length > 0
          ? `${path}: no journey to run — pass a journey id or set "journey" in the scenario`
          : "missing journey id (hogsend simulate <journeyId>)",
      );
    }
    if (args.journeyId && file.journey && file.journey !== args.journeyId) {
      throw new Error(
        `${path} is for journey "${file.journey}", not "${args.journeyId}"`,
      );
    }
    const fileUser = file.scenario.user;
    const user: TestJourneyUser = {
      id: args.userId ?? args.user?.id ?? fileUser?.id ?? DEFAULT_USER.id,
      email:
        args.email ?? args.user?.email ?? fileUser?.email ?? DEFAULT_USER.email,
      properties: {
        ...(fileUser?.properties ?? {}),
        ...(args.user?.properties ?? {}),
      },
    };
    const now = args.now ?? file.scenario.now ?? clock.toISOString();
    const until = args.until ?? file.scenario.until;
    const events = [...(file.scenario.events ?? []), ...args.events];
    const scenario: ScenarioData = {
      ...file.scenario,
      user,
      now,
      ...(until !== undefined ? { until } : {}),
      ...(events.length > 0 ? { events } : {}),
    };
    return { journeyId, scenario, source: path };
  });
}
