import { parseArgs } from "node:util";
import { isHttpError } from "../lib/http.js";
import { color } from "../lib/output.js";
import type { Command, CommandContext } from "./types.js";

const usage = `hogsend journeys <subcommand> [options]

Inspect and toggle journeys via the admin API (/v1/admin/journeys).

Subcommands:
  list                       List journeys with status, trigger, and state counts.
  get <id>                   Show one journey: trigger, exitOn, counts, recent states.
  enable <id>                Enable a journey (PATCH { enabled: true }).
  disable <id>               Disable a journey (PATCH { enabled: false }).

Options:
  list:
    --enabled <true|false>   Filter by enabled state.
    --limit <n>              Page size (1-100, default 50).
    --offset <n>             Page offset (default 0).
  --json                     Emit machine-readable JSON only.
  -h, --help                 Show this help.

Examples:
  hogsend journeys list --enabled true
  hogsend journeys get activation-welcome --json
  hogsend journeys disable churn-prevention`;

/** Shape returned by GET /v1/admin/journeys. */
interface JourneyCounts {
  active: number;
  waiting: number;
  completed: number;
  failed: number;
  exited: number;
}

interface JourneyListItem {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  trigger: { event: string };
  entryLimit: string;
  counts: JourneyCounts;
}

interface ListResponse {
  journeys: JourneyListItem[];
  total: number;
  limit: number;
  offset: number;
}

interface JourneyState {
  id: string;
  userId: string;
  userEmail: string;
  journeyId: string;
  currentNodeId: string;
  status: string;
  errorMessage: string | null;
  entryCount: number;
  completedAt: string | null;
  exitedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface JourneyDetail extends Omit<JourneyListItem, "trigger"> {
  trigger: { event: string; where?: Record<string, unknown>[] };
  exitOn?: { event: string; where?: Record<string, unknown>[] }[];
  suppress: Record<string, number>;
  recentStates: JourneyState[];
}

interface GetResponse {
  journey: JourneyDetail;
}

interface PatchResponse {
  journey: { id: string; name: string; enabled: boolean; updatedAt: string };
}

function badge(): string {
  return `${color.bgMagenta(color.black(" hogsend "))} journeys`;
}

function statusColor(enabled: boolean): string {
  return enabled ? color.green("enabled") : color.yellow("disabled");
}

async function runList(ctx: CommandContext): Promise<void> {
  const { values } = parseArgs({
    args: ctx.argv,
    allowPositionals: true,
    options: {
      enabled: { type: "string" },
      limit: { type: "string" },
      offset: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    ctx.out.log(usage);
    return;
  }

  if (
    values.enabled !== undefined &&
    !["true", "false"].includes(values.enabled)
  ) {
    ctx.out.fail("--enabled must be 'true' or 'false'");
  }

  const query = {
    enabled: values.enabled,
    limit: values.limit,
    offset: values.offset,
  };

  if (!ctx.json) ctx.out.intro(badge());

  const data = await ctx.out.step("Fetching journeys", () =>
    ctx.http.get<ListResponse>("/v1/admin/journeys", query),
  );

  if (ctx.json) {
    ctx.out.json(data);
    return;
  }

  if (data.journeys.length === 0) {
    ctx.out.note("No journeys matched.", "Journeys");
  } else {
    ctx.out.table(
      data.journeys.map((j) => ({
        id: j.id,
        name: j.name,
        status: statusColor(j.enabled),
        trigger: j.trigger.event,
        active: j.counts.active,
        waiting: j.counts.waiting,
        completed: j.counts.completed,
        failed: j.counts.failed,
      })),
      [
        "id",
        "name",
        "status",
        "trigger",
        "active",
        "waiting",
        "completed",
        "failed",
      ],
    );
  }

  ctx.out.outro(
    `${data.journeys.length} of ${data.total} journey(s) — offset ${data.offset}, limit ${data.limit}`,
  );
}

async function runGet(
  ctx: CommandContext,
  id: string | undefined,
): Promise<void> {
  if (!id) {
    ctx.out.fail(
      "journeys get requires a journey id, e.g. hogsend journeys get activation-welcome",
    );
  }

  if (!ctx.json) ctx.out.intro(badge());

  const data = await ctx.out.step(`Fetching journey ${id}`, () =>
    ctx.http.get<GetResponse>(
      `/v1/admin/journeys/${encodeURIComponent(id as string)}`,
    ),
  );

  if (ctx.json) {
    ctx.out.json(data);
    return;
  }

  const j = data.journey;
  ctx.out.kv(
    {
      id: j.id,
      name: j.name,
      description: j.description ?? "",
      status: statusColor(j.enabled),
      trigger: j.trigger.event,
      entryLimit: j.entryLimit,
      exitOn: j.exitOn?.map((e) => e.event).join(", ") ?? "(none)",
    },
    "Journey",
  );

  ctx.out.kv(
    {
      active: j.counts.active,
      waiting: j.counts.waiting,
      completed: j.counts.completed,
      failed: j.counts.failed,
      exited: j.counts.exited,
    },
    "Counts",
  );

  if (j.recentStates.length === 0) {
    ctx.out.note("No recent journey instances.", "Recent states");
  } else {
    ctx.out.table(
      j.recentStates.map((s) => ({
        userId: s.userId,
        email: s.userEmail,
        status: s.status,
        node: s.currentNodeId,
        updatedAt: s.updatedAt,
      })),
      ["userId", "email", "status", "node", "updatedAt"],
    );
  }

  ctx.out.outro(`Journey ${j.id} is ${j.enabled ? "enabled" : "disabled"}.`);
}

async function runToggle(
  ctx: CommandContext,
  id: string | undefined,
  enabled: boolean,
): Promise<void> {
  const verb = enabled ? "enable" : "disable";
  if (!id) {
    ctx.out.fail(
      `journeys ${verb} requires a journey id, e.g. hogsend journeys ${verb} activation-welcome`,
    );
  }

  if (!ctx.json) ctx.out.intro(badge());

  const data = await ctx.out.step(
    `${enabled ? "Enabling" : "Disabling"} ${id}`,
    () =>
      ctx.http.patch<PatchResponse>(
        `/v1/admin/journeys/${encodeURIComponent(id as string)}`,
        { enabled },
      ),
  );

  if (ctx.json) {
    ctx.out.json(data);
    return;
  }

  const j = data.journey;
  ctx.out.note(
    [
      `${color.bold(j.name)} (${j.id})`,
      `status: ${statusColor(j.enabled)}`,
      `updated: ${j.updatedAt}`,
    ].join("\n"),
    `Journey ${enabled ? "enabled" : "disabled"}`,
  );
  ctx.out.outro(`${j.id} is now ${statusColor(j.enabled)}.`);
}

async function run(ctx: CommandContext): Promise<void> {
  const sub = ctx.argv[0];
  // argv after the subcommand token — positionals/flags for the subcommand.
  const rest = ctx.argv.slice(1);
  const subCtx: CommandContext = { ...ctx, argv: rest };

  try {
    switch (sub) {
      case "list":
        await runList(subCtx);
        return;
      case "get": {
        const id = rest.find((a) => !a.startsWith("-"));
        if (rest.includes("--help") || rest.includes("-h")) {
          ctx.out.log(usage);
          return;
        }
        await runGet(subCtx, id);
        return;
      }
      case "enable": {
        if (rest.includes("--help") || rest.includes("-h")) {
          ctx.out.log(usage);
          return;
        }
        await runToggle(
          subCtx,
          rest.find((a) => !a.startsWith("-")),
          true,
        );
        return;
      }
      case "disable": {
        if (rest.includes("--help") || rest.includes("-h")) {
          ctx.out.log(usage);
          return;
        }
        await runToggle(
          subCtx,
          rest.find((a) => !a.startsWith("-")),
          false,
        );
        return;
      }
      case undefined:
        ctx.out.fail(
          `journeys requires a subcommand (list|get|enable|disable). Run: hogsend journeys --help`,
        );
        return;
      default:
        ctx.out.fail(
          `unknown journeys subcommand '${sub}'. Expected list|get|enable|disable.`,
        );
        return;
    }
  } catch (error) {
    if (isHttpError(error)) {
      if (error.status === 404) {
        ctx.out.fail("journey not found");
      }
      ctx.out.fail(error.message);
    }
    throw error;
  }
}

export const journeysCommand: Command = {
  name: "journeys",
  summary: "List, inspect, enable, and disable journeys",
  usage,
  run,
};
