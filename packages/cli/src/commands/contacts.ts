import { parseArgs } from "node:util";
import { isHttpError } from "../lib/http.js";
import { color } from "../lib/output.js";
import type { Command, CommandContext } from "./types.js";

const usage = `hogsend contacts <subcommand> [options]

Inspect contacts via the admin API (/v1/admin/contacts) and upsert them via the
data plane (PUT /v1/contacts).

Subcommands:
  list                  List contacts (newest activity first).
  get <id>              Get one contact (by id or externalId) + preferences.
  timeline <id>        Merged event/email/journey activity for a contact.
  upsert                Create or update a contact (PUT /v1/contacts).

list options:
  --search <q>          Filter by email/externalId substring.
  --limit <n>           Page size (1-100, default 50).
  --offset <n>          Page offset (default 0).

timeline options:
  --type <t>            Restrict to one of: event | journey | email.
  --limit <n>           Page size (1-100, default 50).
  --offset <n>          Page offset (default 0).

upsert options (at least one of --email / --user-id required):
  --email <addr>        Contact email (a resolvable identity key).
  --user-id <id>        External (distinct) id.
  --prop <key=value>    Contact property; repeatable. Value parsed as JSON,
                        falling back to a string. Uses the data plane (ingest key).
  --props <json>        Contact properties as one JSON object (merged with --prop).
  --list <id>           Subscribe to a list; repeatable.
  --unlist <id>         Unsubscribe from a list; repeatable.

Global options (handled by the router): --url, --admin-key, --data-key, --json,
-h/--help.

Examples:
  hogsend contacts list --search acme@ --json
  hogsend contacts get user_123
  hogsend contacts timeline user_123 --type email --json
  hogsend contacts upsert --email a@b.com --user-id user_123 --prop plan=pro
  hogsend contacts upsert --user-id user_123 --props '{"plan":"pro","seats":5}'`;

type ContactRecord = {
  id: string;
  externalId: string;
  email: string | null;
  properties: Record<string, unknown>;
  firstSeenAt: string;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
};

type Preferences = {
  id: string;
  userId: string;
  email: string;
  unsubscribedAll: boolean;
  suppressed: boolean;
  bounceCount: number;
  categories: Record<string, boolean>;
} | null;

type ListResponse = {
  contacts: ContactRecord[];
  total: number;
  limit: number;
  offset: number;
};

type GetResponse = {
  contact: ContactRecord;
  preferences: Preferences;
};

type TimelineEntry = {
  type: "event" | "journey" | "email";
  timestamp: string;
  data: Record<string, unknown>;
};

type TimelineResponse = {
  timeline: TimelineEntry[];
  total: number;
  limit: number;
  offset: number;
};

/** Shape returned by PUT /v1/contacts. */
type UpsertResponse = {
  id: string;
  created: boolean;
  linked: boolean;
};

const badge = `${color.bgMagenta(color.black(" hogsend "))} contacts`;

/**
 * Parse `--prop key=value` (repeatable) + an optional `--props <json>` object
 * into a single properties record. Each `--prop` value is JSON-parsed when it
 * is valid JSON (numbers/booleans/null/objects), else kept as a string. The
 * explicit `--props` object is applied first, so later `--prop` flags win.
 */
function parseProps(
  ctx: CommandContext,
  propsJson: string | undefined,
  propPairs: string[] | undefined,
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  let any = false;

  if (propsJson !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(propsJson);
    } catch {
      ctx.out.fail(`--props must be valid JSON, got: ${propsJson}`);
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      ctx.out.fail("--props must be a JSON object");
    }
    Object.assign(out, parsed as Record<string, unknown>);
    any = true;
  }

  for (const pair of propPairs ?? []) {
    const eq = pair.indexOf("=");
    if (eq === -1) {
      ctx.out.fail(`--prop must be key=value, got: ${pair}`);
    }
    const key = pair.slice(0, eq).trim();
    if (key === "") {
      ctx.out.fail(`--prop key cannot be empty, got: ${pair}`);
    }
    const raw = pair.slice(eq + 1);
    out[key] = coerceValue(raw);
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

/** Run an HTTP call, mapping HttpError into a clean ctx.out.fail message. */
async function fetchOrFail<T>(
  ctx: CommandContext,
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await ctx.out.step(label, fn);
  } catch (err) {
    if (isHttpError(err)) {
      if (err.status === 404) {
        ctx.out.fail(err.message || "contact not found");
      }
      ctx.out.fail(err.message);
    }
    throw err;
  }
}

async function runList(ctx: CommandContext, argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      search: { type: "string" },
      limit: { type: "string" },
      offset: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    ctx.out.log(usage);
    return;
  }

  const query = {
    search: values.search,
    limit: values.limit,
    offset: values.offset,
  };

  if (!ctx.json) ctx.out.intro(`${badge} list`);

  const res = await fetchOrFail<ListResponse>(ctx, "Fetching contacts", () =>
    ctx.http.get<ListResponse>("/v1/admin/contacts", query),
  );

  if (ctx.json) {
    ctx.out.json(res);
    return;
  }

  ctx.out.table(
    res.contacts.map((cnt) => ({
      id: cnt.id,
      externalId: cnt.externalId,
      email: cnt.email ?? color.dim("(none)"),
      lastSeenAt: cnt.lastSeenAt,
    })),
    ["id", "externalId", "email", "lastSeenAt"],
  );
  ctx.out.outro(
    `${res.contacts.length} of ${res.total} contact(s) — offset ${res.offset}, limit ${res.limit}`,
  );
}

async function runGet(ctx: CommandContext, argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    ctx.out.log(usage);
    return;
  }

  // positionals[0] is the "get" subcommand token; the id follows it.
  const id = positionals[1];
  if (!id) {
    ctx.out.fail(
      "contacts get requires an id, e.g. hogsend contacts get user_123",
    );
  }

  if (!ctx.json) ctx.out.intro(`${badge} get`);

  const res = await fetchOrFail<GetResponse>(ctx, "Fetching contact", () =>
    ctx.http.get<GetResponse>(`/v1/admin/contacts/${encodeURIComponent(id)}`),
  );

  if (ctx.json) {
    ctx.out.json(res);
    return;
  }

  const { contact, preferences } = res;
  ctx.out.kv(
    {
      id: contact.id,
      externalId: contact.externalId,
      email: contact.email ?? color.dim("(none)"),
      firstSeenAt: contact.firstSeenAt,
      lastSeenAt: contact.lastSeenAt,
      properties: contact.properties,
    },
    "Contact",
  );

  if (preferences) {
    ctx.out.kv(
      {
        unsubscribedAll: preferences.unsubscribedAll,
        suppressed: preferences.suppressed,
        bounceCount: preferences.bounceCount,
        categories: preferences.categories,
      },
      "Preferences",
    );
  } else {
    ctx.out.log(color.dim("No email preferences on record."));
  }

  ctx.out.outro(`Contact ${color.cyan(contact.externalId)}`);
}

async function runTimeline(ctx: CommandContext, argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      type: { type: "string" },
      limit: { type: "string" },
      offset: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    ctx.out.log(usage);
    return;
  }

  // positionals[0] is the "timeline" subcommand token; the id follows it.
  const id = positionals[1];
  if (!id) {
    ctx.out.fail(
      "contacts timeline requires an id, e.g. hogsend contacts timeline user_123",
    );
  }

  if (values.type && !["event", "journey", "email"].includes(values.type)) {
    ctx.out.fail("--type must be one of: event, journey, email");
  }

  const query = {
    type: values.type,
    limit: values.limit,
    offset: values.offset,
  };

  if (!ctx.json) ctx.out.intro(`${badge} timeline`);

  const res = await fetchOrFail<TimelineResponse>(
    ctx,
    "Fetching timeline",
    () =>
      ctx.http.get<TimelineResponse>(
        `/v1/admin/contacts/${encodeURIComponent(id)}/timeline`,
        query,
      ),
  );

  if (ctx.json) {
    ctx.out.json(res);
    return;
  }

  ctx.out.table(
    res.timeline.map((entry) => ({
      timestamp: entry.timestamp,
      type: entry.type,
      summary: summarizeTimelineEntry(entry),
    })),
    ["timestamp", "type", "summary"],
  );
  ctx.out.outro(
    `${res.timeline.length} of ${res.total} entry(s) — offset ${res.offset}, limit ${res.limit}`,
  );
}

/** One-line human description of a timeline entry, by type. */
function summarizeTimelineEntry(entry: TimelineEntry): string {
  const d = entry.data;
  if (entry.type === "event") {
    return String(d.event ?? "");
  }
  if (entry.type === "journey") {
    return `${String(d.journeyId ?? "")} (${String(d.status ?? "")})`;
  }
  // email
  const subject = d.subject ? String(d.subject) : String(d.templateKey ?? "");
  return `${subject} [${String(d.status ?? "")}]`;
}

async function runUpsert(ctx: CommandContext, argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      email: { type: "string" },
      "user-id": { type: "string" },
      prop: { type: "string", multiple: true },
      props: { type: "string" },
      list: { type: "string", multiple: true },
      unlist: { type: "string", multiple: true },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    ctx.out.log(usage);
    return;
  }

  const email = values.email;
  const userId = values["user-id"];
  if (!email && !userId) {
    ctx.out.fail(
      "contacts upsert requires at least one of --email or --user-id",
    );
  }

  const properties = parseProps(ctx, values.props, values.prop);
  const lists = parseLists(values.list, values.unlist);

  const body: {
    email?: string;
    userId?: string;
    properties?: Record<string, unknown>;
    lists?: Record<string, boolean>;
  } = {};
  if (email) body.email = email;
  if (userId) body.userId = userId;
  if (properties) body.properties = properties;
  if (lists) body.lists = lists;

  if (!ctx.json) ctx.out.intro(`${badge} upsert`);

  const res = await fetchOrFail<UpsertResponse>(ctx, "Upserting contact", () =>
    ctx.dataHttp.put<UpsertResponse>("/v1/contacts", body),
  );

  if (ctx.json) {
    ctx.out.json(res);
    return;
  }

  ctx.out.kv(
    {
      id: res.id,
      created: res.created,
      linked: res.linked,
      email: email ?? color.dim("(none)"),
      userId: userId ?? color.dim("(none)"),
    },
    "Contact",
  );
  const verb = res.created ? "created" : "updated";
  ctx.out.outro(`Contact ${color.cyan(res.id)} ${verb}.`);
}

async function run(ctx: CommandContext): Promise<void> {
  const sub = ctx.argv[0];

  switch (sub) {
    case "list":
      return runList(ctx, ctx.argv);
    case "get":
      return runGet(ctx, ctx.argv);
    case "timeline":
      return runTimeline(ctx, ctx.argv);
    case "upsert":
      // Strip the leading "upsert" token; the rest is upsert's own flags.
      return runUpsert(ctx, ctx.argv.slice(1));
    case undefined:
      ctx.out.fail(
        "contacts requires a subcommand: list, get, timeline, or upsert (see hogsend contacts --help)",
      );
      break;
    default:
      ctx.out.fail(
        `unknown contacts subcommand "${sub}" — expected list, get, timeline, or upsert`,
      );
  }
}

export const contactsCommand: Command = {
  name: "contacts",
  summary: "List, inspect, trace, and upsert contacts",
  usage,
  run,
};
