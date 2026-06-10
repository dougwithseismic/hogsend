import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { color } from "../lib/output.js";
import {
  type ManagedProcess,
  shutdownAll,
  spawnManaged,
  waitForHttp,
} from "../lib/proc.js";
import {
  detectRunningInfra,
  dockerComposeUp,
  ensureAuthSecret,
  ensureEnvFile,
  hasComposeFile,
  probeTcp,
  readDotEnv,
  runMigrations,
} from "../lib/setup-steps.js";
import { runSend } from "./events.js";
import type { Command, CommandContext } from "./types.js";

const usage = `hogsend dev [options]
hogsend dev --fire <event> [event-send options]

Run the full local stack for a Hogsend app from one command:

  1. infra      detect running containers, docker compose up -d when needed
  2. .env       cp .env.example -> .env + generate BETTER_AUTH_SECRET
  3. migrate    pnpm db:migrate (when the app has the script)
  4. spawn      [api] pnpm run dev  +  [worker] hatchet worker dev
                (falls back to pnpm run worker:dev without hatchet CLI/config)
  5. health     wait for GET /v1/health, then print the local URLs

Ctrl+C stops everything — the API, the worker, and their whole process trees.

Options:
  --cwd <dir>      Project root to run in (defaults to the current directory).
  --no-worker      Start the API only (skip the worker process).
  --no-infra       Skip the docker/.env/migrate steps (infra managed elsewhere).
  --fire <event>   Don't boot anything — send a test event to the RUNNING
                   instance via POST /v1/events (works from a second terminal
                   while hogsend dev runs in the first). Accepts every
                   \`hogsend events send\` option: --email, --user-id, --prop,
                   --props, --contact-prop, --contact-props, --list, --unlist,
                   --idempotency-key, --timestamp.
  -h, --help       Show this help.

Examples:
  hogsend dev
  hogsend dev --cwd apps/api
  hogsend dev --no-worker
  hogsend dev --fire signup --email a@b.com --prop plan=pro`;

/**
 * Structural type for GET /v1/admin/domain — deliberately NOT imported from
 * the engine so \`hogsend dev\` works against engines without the domain
 * feature (the call is guarded; on 404/501/error the line is just omitted).
 */
export interface DomainStatusLike {
  domain: string | null;
  status: { state: string } | null;
  testMode: { active: boolean; redirectTo: string | null } | null;
}

/** Render the one-line domain/test-mode status, or null when there's nothing to say. */
export function renderDomainLine(d: DomainStatusLike): string | null {
  if (d.testMode?.active) {
    const target = d.testMode.redirectTo ?? "(no redirect address)";
    const state = d.status?.state;
    const suffix =
      d.domain && state && state !== "verified" ? ` (domain ${state})` : "";
    return color.yellow(
      `Test mode active — emails redirect to ${target}${suffix}`,
    );
  }
  if (d.domain && d.status) {
    const state =
      d.status.state === "verified"
        ? color.green("verified")
        : color.yellow(d.status.state);
    return `${color.dim("Domain")}   ${d.domain} — ${state}`;
  }
  return null;
}

/**
 * Guarded soft-consume of GET /v1/admin/domain. Returns null (omitting the
 * line entirely) when no admin key is configured, when the route 404s/501s
 * (engine without the domain feature), or on any network/shape error. Never
 * throws, never delays startup beyond one quick request.
 */
export async function fetchDomainLine(
  ctx: CommandContext,
): Promise<string | null> {
  if (!ctx.cfg.adminKey) return null;
  try {
    const d = await ctx.http.get<DomainStatusLike>("/v1/admin/domain");
    if (d === null || typeof d !== "object") return null;
    return renderDomainLine(d);
  } catch {
    return null;
  }
}

/**
 * Detect `--fire <event>` / `--fire=<event>` anywhere in argv, returning the
 * event plus the remaining args (handed verbatim to the events send parser).
 */
function extractFire(
  argv: string[],
): { event: string; rest: string[] } | { error: string } | null {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (token === "--fire") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) {
        return {
          error:
            "--fire requires an event name, e.g. hogsend dev --fire signup --email a@b.com",
        };
      }
      return {
        event: next,
        rest: [...argv.slice(0, i), ...argv.slice(i + 2)],
      };
    }
    if (token.startsWith("--fire=")) {
      const event = token.slice("--fire=".length);
      if (event === "") {
        return { error: "--fire requires an event name" };
      }
      return { event, rest: [...argv.slice(0, i), ...argv.slice(i + 1)] };
    }
  }
  return null;
}

/** The --fire path: quick reachability check, then delegate to events send. */
async function runFire(
  ctx: CommandContext,
  event: string,
  rest: string[],
): Promise<void> {
  if (rest.includes("-h") || rest.includes("--help")) {
    ctx.out.log(usage);
    return;
  }

  try {
    const res = await fetch(`${ctx.cfg.baseUrl}/v1/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) throw new Error(`health returned HTTP ${res.status}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.out.fail(
      `cannot reach ${ctx.cfg.baseUrl} — is hogsend dev running? (${msg})`,
    );
  }

  await runSend(ctx, [event, ...rest]);
}

interface PackageJsonLike {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/**
 * Verify `cwd` is a runnable Hogsend app: package.json with `dev` +
 * `worker:dev` scripts and `@hogsend/engine` as a dependency (covers both
 * create-hogsend scaffolds and the dogfood apps/api). Fails with the missing
 * piece named.
 */
function assertHogsendApp(cwd: string, ctx: CommandContext): PackageJsonLike {
  const pkgPath = join(cwd, "package.json");
  if (!existsSync(pkgPath)) {
    ctx.out.fail(
      `not a Hogsend app — no package.json in ${cwd}. Run inside a scaffolded ` +
        "app (pnpm dlx create-hogsend@latest) or pass --cwd <dir>.",
    );
  }

  let pkg: PackageJsonLike;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as PackageJsonLike;
  } catch (err) {
    ctx.out.fail(
      `could not parse ${pkgPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const scripts = pkg.scripts ?? {};
  for (const script of ["dev", "worker:dev"]) {
    if (!scripts[script]) {
      ctx.out.fail(
        `not a runnable Hogsend app — package.json in ${cwd} has no "${script}" ` +
          "script. Scaffold one with pnpm dlx create-hogsend@latest, or pass " +
          "--cwd <dir>.",
      );
    }
  }

  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (!deps["@hogsend/engine"]) {
    ctx.out.fail(
      `not a Hogsend app — @hogsend/engine is not a dependency in ${pkgPath}. ` +
        "Scaffold one with pnpm dlx create-hogsend@latest, or pass --cwd <dir>.",
    );
  }

  return pkg;
}

/** True when the hatchet CLI binary is available on PATH. */
function hatchetOnPath(): boolean {
  try {
    const result = spawnSync("hatchet", ["--version"], { stdio: "ignore" });
    return !result.error && result.status === 0;
  } catch {
    return false;
  }
}

function parsePort(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback;
}

/** Infra phase: compose (skipped when already running), .env, migrations. */
async function prepareInfra(
  ctx: CommandContext,
  cwd: string,
  pkg: PackageJsonLike,
): Promise<void> {
  if (!hasComposeFile(cwd)) {
    ctx.out.log(
      color.dim(
        "  no docker-compose file — skipping docker (infra managed elsewhere)",
      ),
    );
  } else {
    const infra = await ctx.out.step("Checking infra", () =>
      detectRunningInfra(cwd),
    );
    if (infra.postgres && infra.redis && infra.hatchet) {
      ctx.out.log(
        color.dim("  infra already running — skipping docker compose up"),
      );
    } else {
      const docker = await ctx.out.step(
        "Starting infra (docker compose up -d)",
        () => dockerComposeUp(cwd, { quiet: ctx.json }),
      );
      if (docker.status === "failed") {
        ctx.out.fail(
          `${docker.detail}. Is Docker running? Start Docker Desktop (or your ` +
            "docker daemon) and re-run hogsend dev — or pass --no-infra when " +
            "infra is managed elsewhere.",
        );
      }
    }
  }

  const envFile = ensureEnvFile(cwd);
  if (envFile.status === "failed") {
    ctx.out.fail(
      `${envFile.detail} — create a .env (or .env.example) in ${cwd} first.`,
    );
  }
  const secret = ensureAuthSecret(cwd);
  ctx.out.log(color.dim(`  env: ${envFile.detail} · ${secret.detail}`));

  if (pkg.scripts?.["db:migrate"]) {
    const migrate = await ctx.out.step(
      "Running migrations (pnpm db:migrate)",
      () => runMigrations(cwd, { quiet: ctx.json }),
    );
    if (migrate.status === "failed") {
      ctx.out.fail(`${migrate.detail} — fix, then re-run hogsend dev.`);
    }
  } else {
    ctx.out.log(color.dim("  no db:migrate script — skipping migrations"));
  }
}

async function run(ctx: CommandContext): Promise<void> {
  // --fire mode never boots the stack; detect it before strict flag parsing
  // so the event-send flags (--email, --prop, ...) pass through verbatim.
  const fire = extractFire(ctx.argv);
  if (fire && "error" in fire) {
    ctx.out.fail(fire.error);
  }
  if (fire) {
    await runFire(ctx, fire.event, fire.rest);
    return;
  }

  const { values } = parseArgs({
    args: ctx.argv,
    allowPositionals: true,
    options: {
      cwd: { type: "string" },
      "no-worker": { type: "boolean", default: false },
      "no-infra": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    ctx.out.log(usage);
    return;
  }

  const cwd = resolve(values.cwd ?? process.cwd());
  const pkg = assertHogsendApp(cwd, ctx);

  ctx.out.intro(
    `${color.bgMagenta(color.black(" hogsend "))} ${color.dim("dev")}`,
  );

  if (!values["no-infra"]) {
    await prepareInfra(ctx, cwd, pkg);
  }

  // Host ports come from the app's .env — pnpm bootstrap may have remapped
  // busy ports, so hardcoded defaults would print wrong URLs there.
  const dotenv = readDotEnv(cwd);
  const port = parsePort(dotenv.PORT, 3002);
  const hatchetPort = parsePort(dotenv.HATCHET_DASHBOARD_PORT, 8888);
  const apiBase = `http://localhost:${port}`;

  if (await probeTcp({ port })) {
    ctx.out.fail(
      `port ${port} is already in use — is another dev server (or hogsend dev) ` +
        `already running? Stop it, or change PORT in ${join(cwd, ".env")}.`,
    );
  }

  const procs: ManagedProcess[] = [];
  let shuttingDown = false;
  const shutdown = async (code: number): Promise<never> => {
    shuttingDown = true;
    await shutdownAll(procs);
    process.exit(code);
  };

  process.once("SIGINT", () => {
    if (shuttingDown) return;
    ctx.out.log(`\n${color.dim("Shutting down…")}`);
    void shutdown(0);
  });
  process.once("SIGTERM", () => {
    if (shuttingDown) return;
    void shutdown(0);
  });

  procs.push(
    spawnManaged({
      name: "api",
      cmd: "pnpm",
      args: ["run", "dev"],
      cwd,
      prefixColor: color.cyan,
    }),
  );

  if (!values["no-worker"]) {
    // The hatchet CLI dev mode needs both the binary AND a hatchet.yaml in the
    // app (the scaffold template ships none) — otherwise plain worker:dev.
    const useHatchetCli =
      existsSync(join(cwd, "hatchet.yaml")) && hatchetOnPath();
    const mode = useHatchetCli ? "hatchet worker dev" : "pnpm run worker:dev";
    ctx.out.log(color.dim(`  worker mode: ${mode}`));
    procs.push(
      spawnManaged({
        name: "worker",
        cmd: useHatchetCli ? "hatchet" : "pnpm",
        args: useHatchetCli ? ["worker", "dev"] : ["run", "worker:dev"],
        cwd,
        prefixColor: color.magenta,
      }),
    );
  }

  // If any child dies on its own, take the rest down and exit with its code.
  for (const proc of procs) {
    proc.onExit(({ code }) => {
      if (shuttingDown) return;
      shuttingDown = true;
      ctx.out.log(
        color.red(
          `\n[${proc.name}] exited with code ${code ?? "?"} — shutting down.`,
        ),
      );
      void shutdownAll(procs).then(() => process.exit(code ?? 1));
    });
  }

  try {
    await ctx.out.step("Waiting for API health", () =>
      waitForHttp(`${apiBase}/v1/health`, 60_000),
    );
  } catch (err) {
    if (shuttingDown) return;
    shuttingDown = true;
    await shutdownAll(procs);
    const msg = err instanceof Error ? err.message : String(err);
    ctx.out.fail(
      `API did not become healthy: ${msg}. Check the [api] log lines above.`,
    );
  }

  const domainLine = await fetchDomainLine(ctx);

  const lines = [
    `${color.green("●")}  API      ${color.cyan(apiBase)}`,
    `${color.green("●")}  Studio   ${color.cyan(`${apiBase}/studio`)}`,
    `${color.green("●")}  Hatchet  ${color.cyan(`http://localhost:${hatchetPort}`)}`,
    `${color.green("●")}  Docs     ${color.cyan("https://docs.hogsend.com")}`,
  ];
  if (domainLine) lines.push("", domainLine);
  lines.push(
    "",
    `${color.dim("Fire a test event:")}  hogsend dev --fire signup --email you@example.com`,
    color.dim("Press Ctrl+C to stop everything."),
  );
  ctx.out.note(lines.join("\n"), "hogsend dev");

  // Keep the process alive until a signal or a child exit triggers shutdown.
  await new Promise<void>(() => {});
}

export const devCommand: Command = {
  name: "dev",
  summary: "Run the full local stack: infra, API + worker, health, URLs",
  usage,
  run,
};
