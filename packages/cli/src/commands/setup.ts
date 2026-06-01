import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { confirm } from "@clack/prompts";
import { color } from "../lib/output.js";
import { bail } from "../lib/prompt.js";
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

/** Generate a 64-char hex secret (32 bytes) for BETTER_AUTH_SECRET. */
function generateSecret(): string {
  return randomBytes(32).toString("hex");
}

const SECRET_KEY = "BETTER_AUTH_SECRET";
const PLACEHOLDER_PREFIX = "change-me";

interface StepResult {
  step: string;
  status: "ok" | "skipped" | "failed";
  detail: string;
}

/**
 * Ensure a `.env` exists (copying `.env.example` when absent) and that
 * BETTER_AUTH_SECRET holds a real generated value rather than the placeholder.
 * Pure-ish: only touches the filesystem, returns a structured result.
 */
function ensureEnv(cwd: string): { copied: StepResult; secret: StepResult } {
  const envPath = join(cwd, ".env");
  const examplePath = join(cwd, ".env.example");

  let copied: StepResult;
  if (existsSync(envPath)) {
    copied = {
      step: "env",
      status: "skipped",
      detail: ".env already exists",
    };
  } else if (existsSync(examplePath)) {
    copyFileSync(examplePath, envPath);
    copied = {
      step: "env",
      status: "ok",
      detail: "copied .env.example -> .env",
    };
  } else {
    copied = {
      step: "env",
      status: "failed",
      detail: "no .env and no .env.example to copy from",
    };
    return {
      copied,
      secret: {
        step: "secret",
        status: "skipped",
        detail: "skipped — no .env",
      },
    };
  }

  // (Re)read the file we just ensured exists and refresh the secret if it is
  // missing or still the scaffold placeholder. Never overwrite a real secret.
  let raw: string;
  try {
    raw = readFileSync(envPath, "utf8");
  } catch (err) {
    return {
      copied,
      secret: {
        step: "secret",
        status: "failed",
        detail: `could not read .env: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  const lines = raw.split(/\r?\n/);
  const idx = lines.findIndex((l) =>
    l
      .replace(/^export\s+/, "")
      .trimStart()
      .startsWith(`${SECRET_KEY}=`),
  );
  const existingLine = idx === -1 ? undefined : lines[idx];
  const current =
    existingLine === undefined
      ? undefined
      : existingLine.slice(existingLine.indexOf("=") + 1).trim();
  const isPlaceholder =
    current === undefined ||
    current === "" ||
    current.startsWith(PLACEHOLDER_PREFIX);

  if (!isPlaceholder) {
    return {
      copied,
      secret: {
        step: "secret",
        status: "skipped",
        detail: `${SECRET_KEY} already set`,
      },
    };
  }

  const secret = generateSecret();
  const newLine = `${SECRET_KEY}=${secret}`;
  if (idx === -1) {
    if (raw.length > 0 && !raw.endsWith("\n")) lines.push("");
    lines.push(newLine);
  } else {
    lines[idx] = newLine;
  }
  writeFileSync(envPath, lines.join("\n"));

  return {
    copied,
    secret: {
      step: "secret",
      status: "ok",
      detail: `generated ${SECRET_KEY} (64-char hex)`,
    },
  };
}

/** Run a shell command, capturing exit status. */
function runCmd(
  cmd: string,
  args: string[],
  cwd: string,
  json: boolean,
): { status: number | null; ok: boolean } {
  const result = spawnSync(cmd, args, {
    cwd,
    // In json mode stay silent (we report structured status); otherwise stream
    // so the user sees docker / migration output inline.
    stdio: json ? "ignore" : "inherit",
  });
  return { status: result.status, ok: result.status === 0 };
}

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

  const hasCompose =
    existsSync(join(cwd, "docker-compose.yml")) ||
    existsSync(join(cwd, "docker-compose.yaml")) ||
    existsSync(join(cwd, "compose.yml")) ||
    existsSync(join(cwd, "compose.yaml"));

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

  // 1. docker compose up -d
  if (hasCompose) {
    const docker = await ctx.out.step(
      "Starting infra (docker compose up -d)",
      async () => runCmd("docker", ["compose", "up", "-d"], cwd, ctx.json),
    );
    results.push({
      step: "docker",
      status: docker.ok ? "ok" : "failed",
      detail: docker.ok
        ? "Postgres + Redis + Hatchet-Lite up"
        : `docker compose exited with code ${docker.status ?? "?"}`,
    });
  } else {
    results.push({
      step: "docker",
      status: "skipped",
      detail: "no docker-compose file found",
    });
  }

  // 2 + 3. .env + secret (synchronous fs work, wrapped in a step for the spinner)
  const env = await ctx.out.step("Preparing .env + auth secret", async () =>
    ensureEnv(cwd),
  );
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
      async () => runCmd("pnpm", ["db:migrate"], cwd, ctx.json),
    );
    results.push({
      step: "migrate",
      status: migrate.ok ? "ok" : "failed",
      detail: migrate.ok
        ? "engine + client migrations applied"
        : `pnpm db:migrate exited with code ${migrate.status ?? "?"}`,
    });
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
      `${color.cyan("pnpm dev")}          ${color.dim("# HTTP API on :3002")}`,
      `${color.cyan("pnpm worker:dev")}   ${color.dim("# Hatchet worker, 2nd terminal")}`,
      "",
      `${color.dim("Verify with")} ${color.cyan("hogsend doctor")}${color.dim(".")}`,
      `${color.dim("Grab HATCHET_CLIENT_TOKEN at")} ${color.cyan("http://localhost:8888")} ${color.dim("and set it in .env.")}`,
    ].join("\n"),
    "Next steps",
  );

  if (!ok) {
    ctx.out.fail(
      `${failed.length} step(s) failed — see the table above. Fix and re-run hogsend setup.`,
    );
  }

  ctx.out.outro(
    `${color.green("Done.")} ${color.dim("Local infra is up — go write a journey.")}`,
  );
}

export const setupCommand: Command = {
  name: "setup",
  summary: "Local onboarding: docker compose up, gen secret, db:migrate",
  usage,
  run,
};
