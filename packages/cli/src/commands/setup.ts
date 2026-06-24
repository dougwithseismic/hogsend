import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { confirm } from "@clack/prompts";
import { color } from "../lib/output.js";
import { bail } from "../lib/prompt.js";
import {
  detectRunningInfra,
  dockerComposeUp,
  ensureAuthSecret,
  ensureEnvFile,
  hasComposeFile,
  runMigrations,
  type StepResult,
} from "../lib/setup-steps.js";
import type { Command, CommandContext } from "./types.js";

const usage = `hogsend setup [--cwd <dir>] [--yes] [--json]

Interactive local onboarding for a scaffolded Hogsend app. Mirrors the
create-hogsend "next steps":

  1. docker compose up -d              # Postgres + Redis + Hatchet-Lite
  2. cp .env.example .env  (if missing)
  3. generate a BETTER_AUTH_SECRET     (if still the placeholder)
  4. pnpm db:migrate                   # engine track then client track

Options:
  --cwd <dir>    Project root to run in (defaults to the current directory).
  --yes, -y      Skip confirmation prompts (assume yes). Implied by --json.
  --json         Run non-interactively and emit a single JSON result document.
  -h, --help     Show this help.

Run ${color.cyan("hogsend doctor")} afterwards to verify the instance is healthy.`;

async function run(ctx: CommandContext): Promise<void> {
  const { values } = parseArgs({
    args: ctx.argv,
    allowPositionals: true,
    options: {
      cwd: { type: "string" },
      yes: { type: "boolean", short: "y", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    ctx.out.log(usage);
    return;
  }

  const cwd = values.cwd ?? process.cwd();

  if (!existsSync(join(cwd, "package.json"))) {
    ctx.out.fail(
      `no package.json in ${cwd} — run setup from a scaffolded Hogsend app (or pass --cwd).`,
    );
  }

  const hasCompose = hasComposeFile(cwd);

  // --json implies non-interactive; in TTY human mode we confirm first.
  const skipConfirm = ctx.json || values.yes;

  if (!ctx.json) {
    ctx.out.intro(
      `${color.bgMagenta(color.black(" hogsend "))} ${color.dim("local onboarding")}`,
    );
  }

  if (ctx.out.interactive && !skipConfirm) {
    const proceed = bail(
      await confirm({
        message: `Set up local infra in ${color.cyan(cwd)}? (docker compose up, .env, db:migrate)`,
      }),
    );
    if (!proceed) {
      ctx.out.outro(color.dim("Nothing changed."));
      return;
    }
  }

  const results: StepResult[] = [];

  // 1. docker compose up -d — but skip the (slow, noisy) compose call when
  // detection shows the whole trio is already running (no double-start).
  if (hasCompose) {
    const infra = await ctx.out.step("Checking infra", async () =>
      detectRunningInfra(cwd),
    );
    if (infra.postgres && infra.redis && infra.hatchet) {
      results.push({
        step: "docker",
        status: "skipped",
        detail: "infra already running",
      });
    } else {
      const docker = await ctx.out.step(
        "Starting infra (docker compose up -d)",
        async () => dockerComposeUp(cwd, { quiet: ctx.json }),
      );
      results.push(docker);
    }
  } else {
    results.push({
      step: "docker",
      status: "skipped",
      detail: "no docker-compose file found",
    });
  }

  // 2 + 3. .env + secret (synchronous fs work, wrapped in a step for the spinner)
  const env = await ctx.out.step("Preparing .env + auth secret", async () => ({
    copied: ensureEnvFile(cwd),
    secret: ensureAuthSecret(cwd),
  }));
  results.push(env.copied, env.secret);

  // 4. db:migrate (only attempt if docker didn't hard-fail; still try if skipped)
  const dockerFailed = results.some(
    (r) => r.step === "docker" && r.status === "failed",
  );
  if (dockerFailed) {
    results.push({
      step: "migrate",
      status: "skipped",
      detail:
        "skipped — docker compose failed; bring infra up then run pnpm db:migrate",
    });
  } else {
    const migrate = await ctx.out.step(
      "Running migrations (pnpm db:migrate)",
      async () => runMigrations(cwd, { quiet: ctx.json }),
    );
    results.push(migrate);
  }

  const failed = results.filter((r) => r.status === "failed");
  const ok = failed.length === 0;

  if (ctx.json) {
    ctx.out.json({
      ok,
      cwd,
      steps: results,
    });
    if (!ok) process.exit(1);
    return;
  }

  // Human summary.
  ctx.out.table(
    results.map((r) => ({
      step: r.step,
      status:
        r.status === "ok"
          ? color.green("ok")
          : r.status === "skipped"
            ? color.dim("skipped")
            : color.red("failed"),
      detail: r.detail,
    })),
    ["step", "status", "detail"],
  );

  ctx.out.note(
    [
      `${color.cyan("pnpm dev")}          ${color.dim("# API + Studio on :3002")}`,
      `${color.cyan("pnpm worker:dev")}   ${color.dim("# Hatchet worker, 2nd terminal — runs your journeys")}`,
      "",
      `${color.dim("Studio  ")} ${color.cyan("http://localhost:3002/studio")}   ${color.dim("# dashboard (once dev is running)")}`,
      `${color.dim("Docs    ")} ${color.cyan("https://docs.hogsend.com")}   ${color.dim("# guides + first journey: src/journeys/welcome.ts")}`,
      `${color.dim("Discord ")} ${color.cyan("https://discord.gg/rv6eZNvYrr")}   ${color.dim("# questions, help, and what we're shipping")}`,
      "",
      `${color.dim("Verify with")} ${color.cyan("hogsend doctor")}${color.dim(".")}`,
      `${color.dim("Need a Hatchet token? Grab one at")} ${color.cyan("http://localhost:8888")} ${color.dim("and set HATCHET_CLIENT_TOKEN in .env.")}`,
    ].join("\n"),
    "Next steps",
  );

  if (!ok) {
    ctx.out.fail(
      `${failed.length} step(s) failed — see the table above. Fix and re-run hogsend setup.`,
    );
  }

  ctx.out.outro(
    `${color.magenta("Welcome to Hogsend.")} ${color.dim("Local infra is up — go write a journey.")}`,
  );
}

export const setupCommand: Command = {
  name: "setup",
  summary: "Local onboarding: docker compose up, gen secret, db:migrate",
  usage,
  run,
};
