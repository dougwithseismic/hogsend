import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { renderMermaid } from "@hogsend/core";
import { isHttpError } from "../lib/http.js";
import { mermaidLiveUrl, openInBrowser } from "../lib/mermaid-live.js";
import { color } from "../lib/output.js";
import type { Command, CommandContext } from "./types.js";

// NOTE: ../lib/journey-graph.js (and the docs generator re-exporting it) pulls
// in the `typescript` compiler — a heavyweight import. Both are imported
// DYNAMICALLY inside `runGraph` only, so `journeys list|get|enable|disable`
// never pay the compiler's startup cost.

const usage = `hogsend journeys <subcommand> [options]

Inspect and toggle journeys via the admin API (/v1/admin/journeys).
Render a journey's authored control flow as a Mermaid graph.

Subcommands:
  list                       List journeys with status, trigger, and state counts.
  get <id>                   Show one journey: trigger, exitOn, counts, recent states.
  enable <id>                Enable a journey (PATCH { enabled: true }).
  disable <id>               Disable a journey (PATCH { enabled: false }).
  graph <id>                 Render one journey's control flow as Mermaid.
  graph --all                Generate journey graphs for docs + the admin route.

Options:
  list:
    --enabled <true|false>   Filter by enabled state.
    --limit <n>              Page size (1-100, default 50).
    --offset <n>             Page offset (default 0).
  graph:
    --source <dir>           Journey source dir (default src/journeys).
    --file <path>            Read a single journey file (overrides <id> scan).
    --format <fmt>           Output format: mermaid (default) | summary | json | ascii.
                             mermaid: diagram source (round-trips into docs/decks/mermaid.live).
                             summary: terse Markdown digest for PRs + agents.
                             json:    structured graph + mermaid.
                             ascii:   Unicode boxes for the terminal.
    --out <path>             Write output to a file instead of stdout.
    --open                   Open the diagram in mermaid.live.
    --cwd <dir>              Project root (default process.cwd()).
    --all                    Generate graphs for ALL journeys.
    --fumadocs <dir>         Also mirror into a Fumadocs content dir.
    --manifest <path>        Manifest output path (default .hogsend/journeys.graph.json).
    --no-markdown            With --all: write only the manifest (skip docs/journeys.md).
  --json                     Emit machine-readable JSON only.
  -h, --help                 Show this help.

Examples:
  hogsend journeys list --enabled true
  hogsend journeys get activation-welcome --json
  hogsend journeys disable churn-prevention
  hogsend journeys graph churn-prevention                    # mermaid (default)
  hogsend journeys graph churn-prevention --json             # structured graph
  hogsend journeys graph churn-prevention --format summary   # Markdown digest
  hogsend journeys graph churn-prevention --format ascii     # terminal boxes
  hogsend journeys graph churn-prevention --open             # mermaid.live
  hogsend journeys graph churn-prevention --out docs/churn.md
  hogsend journeys graph --all --out docs/journeys.md --fumadocs apps/docs/content/docs`;

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

/**
 * Resolve the `.ts` file for a journey `<id>` by scanning the source dir (or a
 * single `--file`). Returns the absolute path, or undefined if not found.
 * Async because the scanner (→ `typescript`) is imported lazily.
 */
async function resolveJourneyFile(
  cwd: string,
  id: string | undefined,
  source: string,
  file?: string,
): Promise<string | undefined> {
  if (file) {
    const abs = resolve(cwd, file);
    if (!existsSync(abs)) return undefined;
    return abs;
  }
  if (!id) return undefined;
  const [{ discoverJourneyFiles }, { extractJourneyId }] = await Promise.all([
    import("../lib/journey-graph-docs.js"),
    import("../lib/journey-graph.js"),
  ]);
  for (const candidate of discoverJourneyFiles(resolve(cwd, source))) {
    if (extractJourneyId(candidate) === id) return candidate;
  }
  return undefined;
}

const GRAPH_FORMATS = ["mermaid", "summary", "ascii", "json"] as const;
type GraphFormat = (typeof GRAPH_FORMATS)[number];

/** `hogsend journeys graph` — render one journey, or generate docs/manifest. */
async function runGraph(ctx: CommandContext): Promise<void> {
  const { values, positionals } = parseArgs({
    args: ctx.argv,
    allowPositionals: true,
    options: {
      source: { type: "string" },
      file: { type: "string" },
      format: { type: "string" },
      out: { type: "string" },
      open: { type: "boolean", default: false },
      cwd: { type: "string" },
      all: { type: "boolean", default: false },
      fumadocs: { type: "string" },
      manifest: { type: "string" },
      "no-markdown": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    ctx.out.log(usage);
    return;
  }

  const cwd = values.cwd ?? process.cwd();

  // --- graph --all : docs + manifest generation ---
  if (values.all) {
    const { generateAll } = await import("../lib/journey-graph-docs.js");
    const source = values.source ?? "src/journeys";
    const result = generateAll({
      source,
      out: values.out,
      fumadocs: values.fumadocs,
      manifest: values.manifest,
      markdown: !values["no-markdown"],
      cwd,
    });
    if (ctx.json) {
      ctx.out.json(result);
      return;
    }
    ctx.out.intro(badge());
    const lines = [
      `${color.green(String(result.journeys))} journey(s) graphed`,
      `markdown: ${result.markdownPath ?? "(none)"}`,
      `manifest: ${result.manifestPath ?? "(none)"}`,
    ];
    if (result.fumadocsPath) lines.push(`fumadocs: ${result.fumadocsPath}`);
    for (const w of result.warnings) {
      lines.push(color.yellow(w));
    }
    if (result.skipped.length > 0) {
      lines.push("");
      lines.push(
        `${color.yellow(String(result.skipped.length))} file(s) skipped:`,
      );
      for (const s of result.skipped) lines.push(`  ${color.dim(s)}`);
    }
    ctx.out.note(lines.join("\n"), "Generated journey graphs");
    ctx.out.outro("Done.");
    return;
  }

  // --- graph <id> : render one journey ---
  const format = (values.format ?? "mermaid") as GraphFormat;
  if (!GRAPH_FORMATS.includes(format)) {
    ctx.out.fail(
      `unknown --format '${values.format}'. Expected ${GRAPH_FORMATS.join("|")}.`,
    );
  }

  const id = positionals[0];
  const source = values.source ?? "src/journeys";
  const filePath = await resolveJourneyFile(cwd, id, source, values.file);
  if (!filePath) {
    ctx.out.fail(
      id
        ? `journey '${id}' not found under ${resolve(cwd, source)}. Pass --source <dir> or --file <path>.`
        : "journeys graph requires a journey id, e.g. hogsend journeys graph churn-prevention",
    );
  }

  const { extractJourneyGraph } = await import("../lib/journey-graph.js");
  const graph = extractJourneyGraph(filePath as string);
  graph.sourceFile = relative(cwd, filePath as string);
  const mermaid = renderMermaid(graph);

  if (values.open) {
    const url = mermaidLiveUrl(mermaid);
    const opened = openInBrowser(url);
    if (!ctx.json) {
      ctx.out.log(
        opened ? `opened ${color.dim(url)}` : `open manually: ${url}`,
      );
    }
  }

  if (ctx.json || format === "json") {
    ctx.out.json({ graph, mermaid });
    return;
  }

  // Render the requested textual format.
  //   summary — an agent/PR-friendly Markdown digest (no diagram).
  //   ascii   — Unicode boxes for the terminal. Goes through the "plain"
  //             mermaid variant: beautiful-mermaid's text parser rejects the
  //             quoted labels + theme directive the full variant carries.
  //   mermaid — the default; the diagram source itself.
  let rendered: string;
  if (format === "summary") {
    const { renderJourneySummary } = await import("../lib/journey-summary.js");
    rendered = renderJourneySummary(graph);
  } else if (format === "ascii") {
    rendered = (await import("beautiful-mermaid"))
      .renderMermaidASCII(renderMermaid(graph, { variant: "plain" }), {
        boxBorderPadding: 0,
        colorMode: "none",
        paddingX: 1,
        paddingY: 1,
      })
      .replace(/[ \t]+$/gm, "");
  } else {
    rendered = mermaid;
  }

  if (values.out) {
    const outPath = resolve(cwd, values.out);
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(resolve(outPath, ".."), { recursive: true });
    // Only the raw mermaid diagram needs a fence when written to a .md file;
    // summary is already Markdown and ascii is plain text.
    const fileBody =
      format === "mermaid" ? `\`\`\`mermaid\n${rendered}\n\`\`\`\n` : rendered;
    writeFileSync(outPath, fileBody, "utf8");
    ctx.out.intro(badge());
    ctx.out.note(
      `${graph.journeyId}: ${graph.nodes.length} nodes\nwritten to ${values.out}`,
      "Graph",
    );
    ctx.out.outro("Done.");
    return;
  }

  ctx.out.log(rendered);
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
      case "graph": {
        if (rest.includes("--help") || rest.includes("-h")) {
          ctx.out.log(usage);
          return;
        }
        await runGraph(subCtx);
        return;
      }
      case undefined:
        ctx.out.fail(
          `journeys requires a subcommand (list|get|enable|disable|graph). Run: hogsend journeys --help`,
        );
        return;
      default:
        ctx.out.fail(
          `unknown journeys subcommand '${sub}'. Expected list|get|enable|disable|graph.`,
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
  summary: "List, inspect, graph, enable, and disable journeys",
  usage,
  run,
};
