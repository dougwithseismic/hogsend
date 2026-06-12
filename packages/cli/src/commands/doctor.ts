import { parseArgs } from "node:util";
import { loadDotEnv } from "../lib/config.js";
import { isHttpError } from "../lib/http.js";
import { color } from "../lib/output.js";
import { skillsStaleness } from "../lib/skills.js";
import type { Command, CommandContext } from "./types.js";

/**
 * Best-effort nudge: if the cwd is a Hogsend app whose vendored skills were
 * installed by an OLDER CLI than the one running now, point the user at the
 * refresh. Silent when there's no stamp (not an app dir / never tracked).
 */
function skillsNudge(ctx: CommandContext): void {
  const verdict = skillsStaleness(process.cwd());
  if (!verdict?.stale || ctx.json) return;
  ctx.out.note(
    [
      `Vendored Claude skills are from v${verdict.installed}; this CLI is v${verdict.current}.`,
      "",
      `Refresh: ${color.cyan("hogsend upgrade")} ${color.dim("(deps + skills)")} or ${color.cyan("hogsend skills add --all --force")}.`,
    ].join("\n"),
    "Skills out of date",
  );
}

/**
 * Best-effort nudge: PostHog capture configured (`POSTHOG_API_KEY` in the
 * cwd's `.env` or process env) without `POSTHOG_PERSONAL_API_KEY` means
 * person READS are silently disabled — the phc_ project key is write-only by
 * PostHog's design, so timezone resolution falls back to contact properties.
 * Warn-not-fail: capture and person writes still work.
 */
function analyticsNudge(ctx: CommandContext): void {
  if (ctx.json) return;
  const dotenv = loadDotEnv(process.cwd());
  const captureKey = process.env.POSTHOG_API_KEY ?? dotenv.POSTHOG_API_KEY;
  const personalKey =
    process.env.POSTHOG_PERSONAL_API_KEY ?? dotenv.POSTHOG_PERSONAL_API_KEY;
  if (!captureKey || personalKey) return;
  ctx.out.note(
    [
      "POSTHOG_API_KEY is set without POSTHOG_PERSONAL_API_KEY — person",
      "property READS are disabled (the phc_ project key is write-only by",
      "PostHog's design), so per-user timezone resolution falls back to",
      "contact properties. Capture and person WRITES are unaffected.",
      "",
      `Fix: create a personal API key scoped ${color.cyan("person:read")} and set ${color.cyan("POSTHOG_PERSONAL_API_KEY")}.`,
      `Docs: ${color.cyan("https://hogsend.com/docs/guides/analytics-access")}`,
    ].join("\n"),
    "PostHog person reads disabled",
  );
}

const usage = `hogsend doctor [--url <baseUrl>] [--admin-key <key>] [--json]

Probe a running Hogsend instance via GET /v1/health and report its health:
component status (database, redis), two-track schema state (engine + client),
and an overall verdict.

The health route is unauthenticated, so doctor works without an admin key.

Verdict:
  ok                 service healthy, all components up, schema in sync
  degraded           reachable but a component (database/redis) is down
  migration_pending  reachable but a schema track is behind (pending migrations)
  unreachable        the instance could not be reached at all

Exit code: 0 when ok, 1 when unreachable / degraded / migration_pending.

Options:
  --url <baseUrl>    Target instance (default HOGSEND_API_URL / .env / :3002).
  --admin-key <key>  Unused by doctor (health is unauthenticated).
  --json             Emit machine-readable JSON only.
  -h, --help         Show this help.`;

/** Subset of the engine /v1/health response we render. */
interface HealthComponent {
  status: "up" | "down";
  latencyMs?: number;
}
interface HealthTrack {
  applied: string | null;
  required: string | null;
  inSync: boolean;
  pending: string[];
}
interface HealthResponse {
  status: "healthy" | "degraded" | "migration_pending";
  uptime: number;
  timestamp: string;
  version: string;
  components: {
    database: HealthComponent;
    redis: HealthComponent;
  };
  schema: {
    engine: HealthTrack;
    client: HealthTrack;
  };
}

type Verdict = "ok" | "degraded" | "migration_pending" | "unreachable";

/** Map the server's status onto the CLI verdict vocabulary. */
function toVerdict(status: HealthResponse["status"]): Verdict {
  switch (status) {
    case "healthy":
      return "ok";
    case "degraded":
      return "degraded";
    case "migration_pending":
      return "migration_pending";
  }
}

function componentSymbol(status: "up" | "down"): string {
  return status === "up" ? color.green("up") : color.red("down");
}

function trackLine(name: string, track: HealthTrack): string {
  const sync = track.inSync
    ? color.green("in sync")
    : color.yellow(
        `behind (${track.pending.length} pending: ${
          track.pending.length > 0 ? track.pending.join(", ") : "n/a"
        })`,
      );
  const applied = track.applied ?? color.dim("none");
  const required = track.required ?? color.dim("none");
  return `${color.bold(name.padEnd(7))} applied ${applied} -> required ${required}  ${sync}`;
}

async function run(ctx: CommandContext): Promise<void> {
  const { values } = parseArgs({
    args: ctx.argv,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h", default: false },
    },
    // doctor takes no extra flags of its own; tolerate stray tokens.
    strict: false,
  });

  if (values.help) {
    ctx.out.log(usage);
    return;
  }

  const { baseUrl } = ctx.http.cfg;

  // Fetch health. A transport failure (status 0) means unreachable — we surface
  // that as a first-class verdict rather than a hard error so agents get a
  // structured answer. Any other HttpError (non-2xx) is genuinely exceptional.
  let health: HealthResponse | null = null;
  let reachError: string | null = null;
  try {
    health = await ctx.out.step(`GET ${baseUrl}/v1/health`, () =>
      ctx.http.get<HealthResponse>("/v1/health", undefined, { auth: false }),
    );
  } catch (error) {
    if (isHttpError(error) && error.status === 0) {
      reachError = error.message;
    } else if (isHttpError(error)) {
      // A 4xx/5xx from /v1/health: the instance is up but answering badly.
      // Treat as unreachable-for-health so the verdict stays meaningful.
      reachError = error.message;
    } else {
      throw error;
    }
  }

  if (!health) {
    const verdict: Verdict = "unreachable";
    if (ctx.json) {
      ctx.out.json({
        ok: false,
        verdict,
        baseUrl,
        error: reachError ?? "unreachable",
      });
      process.exit(1);
    }
    ctx.out.note(
      [
        `${color.red("●")} ${color.bold("unreachable")}`,
        "",
        reachError ?? `could not reach ${baseUrl}`,
        "",
        color.dim("Is the instance running? Check --url / HOGSEND_API_URL."),
      ].join("\n"),
      "Doctor",
    );
    ctx.out.outro(color.red("doctor: unreachable"));
    process.exit(1);
  }

  const verdict = toVerdict(health.status);
  const ok = verdict === "ok";

  if (ctx.json) {
    ctx.out.json({
      ok,
      verdict,
      baseUrl,
      version: health.version,
      uptime: health.uptime,
      timestamp: health.timestamp,
      components: health.components,
      schema: health.schema,
      skills: skillsStaleness(process.cwd()) ?? undefined,
    });
    if (!ok) process.exit(1);
    return;
  }

  // Human render.
  const badge = `${color.bgMagenta(color.black(" hogsend "))} doctor`;
  ctx.out.intro(badge);

  const verdictColor =
    verdict === "ok"
      ? color.green
      : verdict === "degraded"
        ? color.red
        : color.yellow;

  const lines = [
    `${verdictColor("●")} ${color.bold(verdict)}`,
    color.dim(
      `${baseUrl}  v${health.version}  up ${Math.round(health.uptime)}s`,
    ),
    "",
    color.bold("Components"),
    `  database  ${componentSymbol(health.components.database.status)}${
      health.components.database.latencyMs !== undefined
        ? color.dim(` ${health.components.database.latencyMs}ms`)
        : ""
    }`,
    `  redis     ${componentSymbol(health.components.redis.status)}${
      health.components.redis.latencyMs !== undefined
        ? color.dim(` ${health.components.redis.latencyMs}ms`)
        : ""
    }`,
    "",
    color.bold("Schema"),
    `  ${trackLine("engine", health.schema.engine)}`,
    `  ${trackLine("client", health.schema.client)}`,
  ];

  ctx.out.note(lines.join("\n"), "Doctor");

  skillsNudge(ctx);
  analyticsNudge(ctx);

  if (ok) {
    ctx.out.outro(color.green("doctor: ok"));
    return;
  }

  ctx.out.outro(verdictColor(`doctor: ${verdict}`));
  process.exit(1);
}

export const doctorCommand: Command = {
  name: "doctor",
  summary: "Probe a running instance's health (GET /v1/health)",
  usage,
  run,
};
