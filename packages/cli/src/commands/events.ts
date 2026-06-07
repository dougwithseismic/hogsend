import { parseArgs } from "node:util";
import { isHttpError } from "../lib/http.js";
import { color } from "../lib/output.js";
import type { Command, CommandContext } from "./types.js";

const usage = `hogsend events <userId> [options]
hogsend events send <name> [options]

Read a single user's event history (admin API), or send an event into the data
plane to drive journeys/buckets.

Read mode — hogsend events <userId>:
  Stream the event history for a single user, newest first. Wraps
  GET /v1/admin/events?userId=<userId>.

  Arguments:
    <userId>          The user (distinct) id to fetch events for. Required.

  Options:
    --event <name>    Filter to a single event name.
    --from <iso>      Only events at/after this ISO-8601 timestamp.
    --to <iso>        Only events at/before this ISO-8601 timestamp.
    --limit <n>       Max events to return (1-100, default 50).
    --offset <n>      Pagination offset (default 0).

Send mode — hogsend events send <name>:
  Push an event into POST /v1/events (data plane, ingest key). At least one of
  --email / --user-id is required.

  Options:
    --email <addr>          Recipient/identity email.
    --user-id <id>          External (distinct) id.
    --prop <key=value>      Event property; repeatable. Value parsed as JSON,
                            falling back to a string.
    --props <json>          Event properties as one JSON object.
    --contact-prop <k=v>    Contact property to merge onto the contact; repeatable.
    --contact-props <json>  Contact properties as one JSON object.
    --list <id>             Subscribe to a list; repeatable.
    --unlist <id>           Unsubscribe from a list; repeatable.
    --idempotency-key <k>   Dedup key (sent as the Idempotency-Key header).
    --timestamp <iso>       Override the event timestamp.

Global options (handled by the router): --url, --admin-key, --data-key, --json,
-h/--help.

Examples:
  hogsend events user_123
  hogsend events user_123 --event signup --limit 10
  hogsend events user_123 --from 2026-01-01T00:00:00Z --json
  hogsend events send signup --user-id user_123 --prop plan=pro
  hogsend events send purchase --email a@b.com --props '{"amount":49}' --json`;

interface UserEvent {
  id: string;
  userId: string;
  event: string;
  properties: Record<string, unknown> | null;
  occurredAt: string;
}

interface EventsResponse {
  events: UserEvent[];
  total: number;
  limit: number;
  offset: number;
}

/** Shape returned by POST /v1/events. */
interface ExitResult {
  journeyId: string;
  stateId: string;
  exited: boolean;
}

interface SendResponse {
  stored: boolean;
  exits: ExitResult[];
}

async function run(ctx: CommandContext): Promise<void> {
  // `events send <name>` is the write path; everything else is the read path
  // (bare `events <userId>`). Dispatch on the first positional WITHOUT a global
  // --help short-circuit here, so `events send --help` still shows usage.
  if (ctx.argv[0] === "send") {
    return runSend(ctx, ctx.argv.slice(1));
  }
  return runRead(ctx, ctx.argv);
}

async function runRead(ctx: CommandContext, argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      event: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      limit: { type: "string" },
      offset: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    ctx.out.log(usage);
    return;
  }

  const userId = positionals[0];
  if (!userId) {
    ctx.out.fail("events requires a userId, e.g. hogsend events user_123");
  }

  const limit = parseNumber(values.limit, "limit", ctx);
  const offset = parseNumber(values.offset, "offset", ctx);

  const query = {
    userId,
    event: values.event,
    from: values.from,
    to: values.to,
    limit,
    offset,
  };

  let data: EventsResponse;
  try {
    data = await ctx.out.step(`Fetching events for ${userId}`, () =>
      ctx.http.get<EventsResponse>("/v1/admin/events", query),
    );
  } catch (error) {
    if (isHttpError(error)) {
      ctx.out.fail(error.message);
    }
    throw error;
  }

  if (ctx.json) {
    ctx.out.json(data);
    return;
  }

  ctx.out.intro(`${color.bgMagenta(color.black(" hogsend "))} events`);

  if (data.events.length === 0) {
    ctx.out.note(
      `No events found for ${color.cyan(userId)}.`,
      "Empty event stream",
    );
    ctx.out.outro(color.dim("Nothing to show."));
    return;
  }

  const rows = data.events.map((e) => ({
    occurredAt: e.occurredAt,
    event: e.event,
    properties: summarizeProps(e.properties),
    id: e.id,
  }));
  ctx.out.table(rows, ["occurredAt", "event", "properties", "id"]);

  const shown = data.events.length;
  const through = data.offset + shown;
  ctx.out.outro(
    `${color.green(String(shown))} event${shown === 1 ? "" : "s"} ` +
      color.dim(`(${data.offset + 1}-${through} of ${data.total})`),
  );
}

async function runSend(ctx: CommandContext, argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      email: { type: "string" },
      "user-id": { type: "string" },
      prop: { type: "string", multiple: true },
      props: { type: "string" },
      "contact-prop": { type: "string", multiple: true },
      "contact-props": { type: "string" },
      list: { type: "string", multiple: true },
      unlist: { type: "string", multiple: true },
      "idempotency-key": { type: "string" },
      timestamp: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    ctx.out.log(usage);
    return;
  }

  // positionals[0] is the event name (the "send" token was already stripped).
  const name = positionals[0];
  if (!name) {
    ctx.out.fail(
      "events send requires an event name, e.g. hogsend events send signup --user-id user_123",
    );
  }

  const email = values.email;
  const userId = values["user-id"];
  if (!email && !userId) {
    ctx.out.fail("events send requires at least one of --email or --user-id");
  }

  const eventProperties = parseProps(ctx, values.props, values.prop, "prop");
  const contactProperties = parseProps(
    ctx,
    values["contact-props"],
    values["contact-prop"],
    "contact-prop",
  );
  const lists = parseLists(values.list, values.unlist);

  const body: {
    name: string;
    email?: string;
    userId?: string;
    eventProperties?: Record<string, unknown>;
    contactProperties?: Record<string, unknown>;
    lists?: Record<string, boolean>;
    idempotencyKey?: string;
    timestamp?: string;
  } = { name };
  if (email) body.email = email;
  if (userId) body.userId = userId;
  if (eventProperties) body.eventProperties = eventProperties;
  if (contactProperties) body.contactProperties = contactProperties;
  if (lists) body.lists = lists;
  if (values["idempotency-key"]) {
    body.idempotencyKey = values["idempotency-key"];
  }
  if (values.timestamp) body.timestamp = values.timestamp;

  let res: SendResponse;
  try {
    res = await ctx.out.step(`Sending event ${name}`, () =>
      ctx.dataHttp.post<SendResponse>("/v1/events", body),
    );
  } catch (error) {
    if (isHttpError(error)) {
      ctx.out.fail(error.message);
    }
    throw error;
  }

  if (ctx.json) {
    ctx.out.json(res);
    return;
  }

  ctx.out.intro(`${color.bgMagenta(color.black(" hogsend "))} events send`);

  const exited = res.exits.filter((e) => e.exited);
  ctx.out.kv(
    {
      event: name,
      stored: res.stored,
      identity: email ?? userId ?? "",
      exits: res.exits.length,
      "journeys exited": exited.length,
    },
    "Event sent",
  );

  if (exited.length > 0) {
    ctx.out.table(
      exited.map((e) => ({ journeyId: e.journeyId, stateId: e.stateId })),
      ["journeyId", "stateId"],
    );
  }

  ctx.out.outro(
    res.stored
      ? `${color.green("Stored")} ${name}.`
      : color.dim(`${name} was deduped (not stored).`),
  );
}

/**
 * Parse `--<flag> key=value` (repeatable) + an optional `--<flag>s <json>`
 * object into a single properties record. Each value is JSON-parsed when valid
 * JSON, else kept as a string. The JSON object is applied first so later
 * key=value flags win. `flagName` is used only for error messages.
 */
function parseProps(
  ctx: CommandContext,
  json: string | undefined,
  pairs: string[] | undefined,
  flagName: string,
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  let any = false;

  if (json !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      ctx.out.fail(`--${flagName}s must be valid JSON, got: ${json}`);
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      ctx.out.fail(`--${flagName}s must be a JSON object`);
    }
    Object.assign(out, parsed as Record<string, unknown>);
    any = true;
  }

  for (const pair of pairs ?? []) {
    const eq = pair.indexOf("=");
    if (eq === -1) {
      ctx.out.fail(`--${flagName} must be key=value, got: ${pair}`);
    }
    const key = pair.slice(0, eq).trim();
    if (key === "") {
      ctx.out.fail(`--${flagName} key cannot be empty, got: ${pair}`);
    }
    out[key] = coerceValue(pair.slice(eq + 1));
    any = true;
  }

  return any ? out : undefined;
}

/** JSON-parse a flag value, falling back to the raw string. */
function coerceValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Build a `lists` map from repeatable `--list <id>` (true) / `--unlist <id>`
 * (false) flags. Returns undefined when neither was passed.
 */
function parseLists(
  subscribe: string[] | undefined,
  unsubscribe: string[] | undefined,
): Record<string, boolean> | undefined {
  const out: Record<string, boolean> = {};
  let any = false;
  for (const id of subscribe ?? []) {
    out[id] = true;
    any = true;
  }
  for (const id of unsubscribe ?? []) {
    out[id] = false;
    any = true;
  }
  return any ? out : undefined;
}

/**
 * Parse an optional numeric flag. Returns undefined when absent (lets the
 * server apply its default); fails on a non-numeric value.
 */
function parseNumber(
  raw: string | undefined,
  name: string,
  ctx: CommandContext,
): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    ctx.out.fail(`--${name} must be a number, got "${raw}"`);
  }
  return n;
}

/** Compact a properties object into a single-line preview for the table. */
function summarizeProps(props: Record<string, unknown> | null): string {
  if (!props) return "";
  const keys = Object.keys(props);
  if (keys.length === 0) return "";
  const preview = JSON.stringify(props);
  return preview.length > 60 ? `${preview.slice(0, 57)}...` : preview;
}

export const eventsCommand: Command = {
  name: "events",
  summary: "Stream a user's event history, or send an event",
  usage,
  run,
};
