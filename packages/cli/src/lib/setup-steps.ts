import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { loadDotEnv } from "./config.js";

/**
 * The shared local-onboarding steps, extracted from `commands/setup.ts` so
 * both `hogsend setup` (which keeps its exact CLI shell) and `hogsend dev`
 * can reuse them. The exported function signatures are pinned
 * (PROJECT_SPEC §d) — only additive optional params are allowed.
 */

export interface StepResult {
  step: string;
  status: "ok" | "skipped" | "failed";
  detail: string;
}

export const SECRET_KEY = "BETTER_AUTH_SECRET";
export const PLACEHOLDER_PREFIX = "change-me";

/** Generate a 64-char hex secret (32 bytes) for BETTER_AUTH_SECRET. */
export function generateSecret(): string {
  return randomBytes(32).toString("hex");
}

const COMPOSE_FILES = [
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
];

/** True when any docker-compose file variant exists in `cwd`. */
export function hasComposeFile(cwd: string): boolean {
  return COMPOSE_FILES.some((name) => existsSync(join(cwd, name)));
}

/**
 * Read the *app's* `.env` (KEY=value lines, `export ` prefix and comments
 * tolerated, never throws). Used for host-port resolution — `pnpm bootstrap`
 * may have remapped busy ports into `.env`, so these values are
 * authoritative over the defaults. Distinct from CLI target-config
 * resolution (`lib/config.ts` `resolveConfig`), which this must not entangle.
 */
export function readDotEnv(cwd: string): Record<string, string> {
  return loadDotEnv(cwd);
}

/** Copy `.env.example` → `.env` when `.env` is missing. */
export function ensureEnvFile(cwd: string): StepResult {
  const envPath = join(cwd, ".env");
  const examplePath = join(cwd, ".env.example");

  if (existsSync(envPath)) {
    return { step: "env", status: "skipped", detail: ".env already exists" };
  }
  if (existsSync(examplePath)) {
    copyFileSync(examplePath, envPath);
    return {
      step: "env",
      status: "ok",
      detail: "copied .env.example -> .env",
    };
  }
  return {
    step: "env",
    status: "failed",
    detail: "no .env and no .env.example to copy from",
  };
}

/**
 * Ensure BETTER_AUTH_SECRET in `.env` holds a real generated value: replaces
 * the scaffold placeholder / a missing key with 64-char hex. NEVER overwrites
 * a real secret. Skipped when no `.env` exists.
 */
export function ensureAuthSecret(cwd: string): StepResult {
  const envPath = join(cwd, ".env");
  if (!existsSync(envPath)) {
    return { step: "secret", status: "skipped", detail: "skipped — no .env" };
  }

  let raw: string;
  try {
    raw = readFileSync(envPath, "utf8");
  } catch (err) {
    return {
      step: "secret",
      status: "failed",
      detail: `could not read .env: ${err instanceof Error ? err.message : String(err)}`,
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
      step: "secret",
      status: "skipped",
      detail: `${SECRET_KEY} already set`,
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
    step: "secret",
    status: "ok",
    detail: `generated ${SECRET_KEY} (64-char hex)`,
  };
}

/** Options shared by the spawning steps. */
export interface RunStepOptions {
  /** Silence child stdio (used by `--json` runs); default streams inline. */
  quiet?: boolean;
}

/** Run a shell command, capturing exit status. */
function runCmd(
  cmd: string,
  args: string[],
  cwd: string,
  quiet: boolean,
): { status: number | null; ok: boolean } {
  const result = spawnSync(cmd, args, {
    cwd,
    stdio: quiet ? "ignore" : "inherit",
  });
  return { status: result.status, ok: result.status === 0 };
}

/** `docker compose up -d` in `cwd`, wrapped as a StepResult. */
export async function dockerComposeUp(
  cwd: string,
  opts?: RunStepOptions,
): Promise<StepResult> {
  const result = runCmd(
    "docker",
    ["compose", "up", "-d"],
    cwd,
    opts?.quiet ?? false,
  );
  return {
    step: "docker",
    status: result.ok ? "ok" : "failed",
    detail: result.ok
      ? "Postgres + Redis + Hatchet-Lite up"
      : `docker compose exited with code ${result.status ?? "?"}`,
  };
}

/** `pnpm db:migrate` in `cwd`, wrapped as a StepResult. */
export async function runMigrations(
  cwd: string,
  opts?: RunStepOptions,
): Promise<StepResult> {
  const result = runCmd("pnpm", ["db:migrate"], cwd, opts?.quiet ?? false);
  return {
    step: "migrate",
    status: result.ok ? "ok" : "failed",
    detail: result.ok
      ? "engine + client migrations applied"
      : `pnpm db:migrate exited with code ${result.status ?? "?"}`,
  };
}

/** TCP connect probe — true when something is listening. Never throws. */
export function probeTcp(opts: {
  port: number;
  host?: string;
  timeoutMs?: number;
}): Promise<boolean> {
  const { port, host = "127.0.0.1", timeoutMs = 750 } = opts;
  return new Promise((resolve) => {
    let settled = false;
    const socket = connect({ port, host });
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(timeoutMs, () => done(false));
  });
}

function envPort(
  env: Record<string, string>,
  key: string,
  fallback: number,
): number {
  const raw = env[key];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback;
}

interface ComposePsEntry {
  service: string;
  state: string;
}

/** Parse `docker compose ps --format json` output (line-json or an array). */
function parseComposePs(stdout: string): ComposePsEntry[] {
  const entries: ComposePsEntry[] = [];
  const push = (value: unknown) => {
    if (value === null || typeof value !== "object") return;
    const obj = value as Record<string, unknown>;
    const service = obj.Service ?? obj.Name;
    const state = obj.State;
    if (typeof service === "string" && typeof state === "string") {
      entries.push({ service, state: state.toLowerCase() });
    }
  };

  const trimmed = stdout.trim();
  if (trimmed === "") return entries;
  if (trimmed.startsWith("[")) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr)) for (const item of arr) push(item);
    } catch {
      // unparseable — treated as no entries
    }
    return entries;
  }
  for (const line of trimmed.split(/\r?\n/)) {
    try {
      push(JSON.parse(line));
    } catch {
      // skip non-json lines (compose warnings etc.)
    }
  }
  return entries;
}

/**
 * Detect whether the local infra trio (Postgres, Redis, Hatchet-Lite) is
 * already running. Strategy:
 *
 *  1. `docker compose ps --format json` in `cwd` — service names mapped to
 *     `running` state;
 *  2. for anything still unknown (docker CLI missing, no compose project in
 *     `cwd`, or containers started elsewhere — e.g. another checkout), fall
 *     back to TCP probes against the host ports read from `cwd/.env`
 *     (`POSTGRES_PORT` 5434, `REDIS_PORT` 6380, `HATCHET_DASHBOARD_PORT`
 *     8888 — `pnpm bootstrap` may have remapped these).
 *
 * Never throws.
 */
export async function detectRunningInfra(
  cwd: string,
): Promise<{ postgres: boolean; redis: boolean; hatchet: boolean }> {
  const found = { postgres: false, redis: false, hatchet: false };

  try {
    const result = spawnSync("docker", ["compose", "ps", "--format", "json"], {
      cwd,
      encoding: "utf8",
    });
    if (
      !result.error &&
      result.status === 0 &&
      typeof result.stdout === "string"
    ) {
      for (const entry of parseComposePs(result.stdout)) {
        if (entry.state !== "running") continue;
        if (entry.service === "postgres") {
          found.postgres = true;
        } else if (entry.service === "redis") {
          found.redis = true;
        } else if (
          entry.service.startsWith("hatchet") &&
          !entry.service.includes("postgres")
        ) {
          found.hatchet = true;
        }
      }
    }
  } catch {
    // fall through to port probes
  }

  if (found.postgres && found.redis && found.hatchet) return found;

  try {
    const env = readDotEnv(cwd);
    const [postgres, redis, hatchet] = await Promise.all([
      found.postgres || probeTcp({ port: envPort(env, "POSTGRES_PORT", 5434) }),
      found.redis || probeTcp({ port: envPort(env, "REDIS_PORT", 6380) }),
      found.hatchet ||
        probeTcp({ port: envPort(env, "HATCHET_DASHBOARD_PORT", 8888) }),
    ]);
    return { postgres, redis, hatchet };
  } catch {
    return found;
  }
}
