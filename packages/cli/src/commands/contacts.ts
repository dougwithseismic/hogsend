import { parseArgs } from "node:util";
import { isHttpError } from "../lib/http.js";
import { color } from "../lib/output.js";
import type { Command, CommandContext } from "./types.js";

const usage = `hogsend contacts <subcommand> [options]

Inspect contacts via the running app's admin API (/v1/admin/contacts).

Subcommands:
  list                  List contacts (newest activity first).
  get <id>              Get one contact (by id or externalId) + preferences.
  timeline <id>        Merged event/email/journey activity for a contact.

list options:
  --search <q>          Filter by email/externalId substring.
  --limit <n>           Page size (1-100, default 50).
  --offset <n>          Page offset (default 0).

timeline options:
  --type <t>            Restrict to one of: event | journey | email.
  --limit <n>           Page size (1-100, default 50).
  --offset <n>          Page offset (default 0).

Global options (handled by the router): --url, --admin-key, --json, -h/--help.

Examples:
  hogsend contacts list --search acme@ --json
  hogsend contacts get user_123
  hogsend contacts timeline user_123 --type email --json`;

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

const badge = `${color.bgMagenta(color.black(" hogsend "))} contacts`;

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

async function run(ctx: CommandContext): Promise<void> {
  const sub = ctx.argv[0];

  switch (sub) {
    case "list":
      return runList(ctx, ctx.argv);
    case "get":
      return runGet(ctx, ctx.argv);
    case "timeline":
      return runTimeline(ctx, ctx.argv);
    case undefined:
      ctx.out.fail(
        "contacts requires a subcommand: list, get, or timeline (see hogsend contacts --help)",
      );
      break;
    default:
      ctx.out.fail(
        `unknown contacts subcommand "${sub}" — expected list, get, or timeline`,
      );
  }
}

export const contactsCommand: Command = {
  name: "contacts",
  summary: "List, inspect, and trace contact activity",
  usage,
  run,
};
