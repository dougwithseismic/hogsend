import { parseArgs } from "node:util";
import { isHttpError } from "../lib/http.js";
import { color } from "../lib/output.js";
import type { Command, CommandContext } from "./types.js";

const usage = `hogsend events <userId> [options]

Stream the event history for a single user, newest first. Wraps
GET /v1/admin/events?userId=<userId>.

Arguments:
  <userId>            The user (distinct) id to fetch events for. Required.

Options:
  --event <name>      Filter to a single event name.
  --from <iso>        Only events at/after this ISO-8601 timestamp.
  --to <iso>          Only events at/before this ISO-8601 timestamp.
  --limit <n>         Max events to return (1-100, default 50).
  --offset <n>        Pagination offset (default 0).
  --json              Emit machine-readable JSON only.
  -h, --help          Show this help.

Examples:
  hogsend events user_123
  hogsend events user_123 --event signup --limit 10
  hogsend events user_123 --from 2026-01-01T00:00:00Z --json`;

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

async function run(ctx: CommandContext): Promise<void> {
  const { values, positionals } = parseArgs({
    args: ctx.argv,
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
  summary: "Stream a single user's event history",
  usage,
  run,
};
