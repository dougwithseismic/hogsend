import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

/**
 * The one-command local setup (run via `<pm> run bootstrap`).
 *
 * Idempotent and safe to re-run. It:
 *   1. checks Docker is installed + running
 *   2. creates `.env` from `.env.example` with a fresh BETTER_AUTH_SECRET
 *   3. remaps any conflicting host ports (so multiple Hogsend stacks coexist)
 *   4. brings up Postgres + Redis + Hatchet-Lite and waits for health
 *   5. mints a Hatchet API token and writes it to `.env`
 *   6. runs the two-track database migrations (and verifies the engine track)
 *   7. mints API keys → `.env`: HOGSEND_API_KEY (ingest) + HOGSEND_ADMIN_KEY
 *      (full-admin, used by the `hogsend` CLI)
 *   8. (optional, interactive) creates your first Studio admin via the CLI
 *   9. (optional, interactive; only when PostHog was chosen) runs the real
 *      `hogsend connect posthog` OAuth flow against a briefly-booted API
 *
 * After this, the `dev` + `worker:dev` scripts just work. Docs: docs.hogsend.com
 */

// Default seed tenant baked into the hatchet-lite image. Overridden at runtime
// by whatever `/config/server.yaml` reports, so a future image can't break us.
const DEFAULT_HATCHET_TENANT = "707d0855-80ab-4e1f-a156-f1c4546cbf52";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = join(ROOT, ".env");
const ENV_EXAMPLE = join(ROOT, ".env.example");
const PROJECT = sanitizeName(basename(ROOT));

// --- tiny ANSI helpers (no deps in the scaffolded app) ---------------------
const isTTY = Boolean(process.stdout.isTTY);
const paint =
  (code: string) =>
  (s: string): string =>
    isTTY ? `\x1b[${code}m${s}\x1b[0m` : s;
const bold = paint("1");
const dim = paint("2");
const red = paint("31");
const green = paint("32");
const yellow = paint("33");
const cyan = paint("36");
const magenta = paint("35");

let stepNo = 0;
let TOTAL = 8;
function step(label: string): void {
  stepNo += 1;
  process.stdout.write(
    `\n${magenta(bold(`[${stepNo}/${TOTAL}]`))} ${bold(label)}\n`,
  );
}
function ok(msg: string): void {
  process.stdout.write(`  ${green("✓")} ${msg}\n`);
}
function info(msg: string): void {
  process.stdout.write(`  ${dim("·")} ${dim(msg)}\n`);
}
function warn(msg: string): void {
  process.stdout.write(`  ${yellow("!")} ${msg}\n`);
}
/**
 * A step failure the run can survive (unlike `die`) but that MUST NOT be
 * papered over by the final "✓ Ready." banner. Recorded and re-surfaced in the
 * summary; the process exits 1 so wrappers (create-hogsend's setup step, CI)
 * see the truth too.
 */
const issues: string[] = [];
function issue(msg: string): void {
  warn(msg);
  issues.push(msg);
}
function die(msg: string, hint?: string): never {
  // Restore the cursor in case we died mid-spin (startSpinner hides it).
  if (isTTY) process.stdout.write("\x1b[?25h");
  process.stdout.write(`\n  ${red("✗")} ${msg}\n`);
  if (hint) process.stdout.write(`    ${dim(hint)}\n`);
  process.exit(1);
}

/**
 * Dependency-free single-line spinner (the scaffolded app has no clack). Off a
 * TTY it just prints the message once and returns a no-op, so CI logs stay
 * linear. Returns a `stop()` that clears the line and restores the cursor.
 */
function startSpinner(message: string): () => void {
  if (!isTTY) {
    info(message);
    return () => {};
  }
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  process.stdout.write("\x1b[?25l"); // hide cursor
  const timer = setInterval(() => {
    // `?? "⠋"` keeps `frame` a string under noUncheckedIndexedAccess (the
    // scaffold's tsconfig) — the modulo guarantees a valid index anyway.
    const frame = frames[i % frames.length] ?? "⠋";
    i += 1;
    process.stdout.write(`\r  ${cyan(frame)} ${dim(message)}`);
  }, 80);
  return () => {
    clearInterval(timer);
    process.stdout.write("\r\x1b[2K\x1b[?25h"); // clear line + show cursor
  };
}

/**
 * Yes/No prompt that defaults to NO and auto-skips (returns the default) when
 * there is no TTY — so CI / piped runs never block. No deps: plain readline.
 */
async function confirm(question: string, def = false): Promise<boolean> {
  if (!process.stdin.isTTY) return def;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const hint = def ? "Y/n" : "y/N";
    const answer = (await rl.question(`  ${question} ${dim(`(${hint})`)} `))
      .trim()
      .toLowerCase();
    if (answer === "") return def;
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

// --- generic helpers -------------------------------------------------------
function sanitizeName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "");
  return cleaned || "hogsend-app";
}

/** Which package manager invoked us (`npm_config_user_agent`). */
function detectPm(): string {
  const name = (process.env.npm_config_user_agent ?? "").split("/")[0];
  return name === "npm" || name === "yarn" || name === "bun" ? name : "pnpm";
}

const PM = detectPm();

/** Idiomatic "run a script" for the active pm — only npm needs the `run` word. */
function pmRun(script: string): string {
  return PM === "npm" ? `npm run ${script}` : `${PM} ${script}`;
}

/**
 * Idiomatic "run a locally-installed bin" for the active pm. The `hogsend` CLI
 * ships with the app's dependencies (`@hogsend/cli`), not on the PATH — a bare
 * `hogsend …` hint sends users into `command not found`.
 */
function pmExec(bin: string): string {
  if (PM === "npm") return `npx ${bin}`; // npx prefers the local bin
  if (PM === "bun") return `bunx ${bin}`;
  return `${PM} ${bin}`;
}

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[]): Run {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8" });
  return {
    status: r.status ?? 1,
    stdout: (r.stdout ?? "").trim(),
    stderr: (r.stderr ?? "").trim(),
  };
}

/** Stream a command's output straight to the terminal (for long/noisy steps). */
function runLive(cmd: string, args: string[], shell = false): number {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", shell });
  return r.status ?? 1;
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((res) => {
    const srv = createServer();
    srv.once("error", () => res(false));
    srv.once("listening", () => srv.close(() => res(true)));
    srv.listen(port, "0.0.0.0");
  });
}

async function findFreePort(
  start: number,
  taken: Set<number>,
): Promise<number> {
  let port = start;
  while (taken.has(port) || !(await isPortFree(port))) port += 1;
  taken.add(port);
  return port;
}

// --- .env helpers ----------------------------------------------------------
function getEnv(content: string, key: string): string | undefined {
  return content.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1];
}

function setEnv(content: string, key: string, value: string): string {
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(content)) return content.replace(re, `${key}=${value}`);
  return `${content.trimEnd()}\n${key}=${value}\n`;
}

function portInUrl(url: string): number | undefined {
  const m = url.match(/:\/\/[^/]*?:(\d+)/);
  return m ? Number(m[1]) : undefined;
}

function withPort(url: string, port: number): string {
  return url.replace(/(:\/\/[^/]*?:)\d+/, `$1${port}`);
}

// --- 1. Docker -------------------------------------------------------------
function checkDocker(): void {
  if (run("docker", ["--version"]).status !== 0) {
    die(
      "Docker is not installed.",
      "Install Docker Desktop → https://docs.docker.com/get-docker/",
    );
  }
  if (run("docker", ["info"]).status !== 0) {
    die(
      "Docker is installed but the daemon isn't running.",
      `Start Docker Desktop and re-run \`${pmRun("bootstrap")}\`.`,
    );
  }
  ok("Docker is running");
}

// --- 2. .env ---------------------------------------------------------------
function ensureEnv(): void {
  if (existsSync(ENV_PATH)) {
    ok(".env already exists — keeping it");
    return;
  }
  if (!existsSync(ENV_EXAMPLE))
    die(".env.example is missing — cannot create .env");
  copyFileSync(ENV_EXAMPLE, ENV_PATH);
  let content = readFileSync(ENV_PATH, "utf8");
  content = setEnv(
    content,
    "BETTER_AUTH_SECRET",
    randomBytes(32).toString("base64"),
  );
  writeFileSync(ENV_PATH, content);
  ok("Created .env with a fresh BETTER_AUTH_SECRET");
}

// --- 3. ports --------------------------------------------------------------
interface Ports {
  pg: number;
  redis: number;
  grpc: number;
  dash: number;
  /** The app's own HTTP port (PORT / API_PUBLIC_URL) — remapped like the rest. */
  app: number;
}

async function resolvePorts(): Promise<Ports> {
  const env = readFileSync(ENV_PATH, "utf8");
  const dbUrl = getEnv(env, "DATABASE_URL") ?? "";
  const redisUrl = getEnv(env, "REDIS_URL") ?? "";
  const hostPort = getEnv(env, "HATCHET_CLIENT_HOST_PORT") ?? "localhost:7077";

  const want: Ports = {
    pg: portInUrl(dbUrl) ?? 5434,
    redis: portInUrl(redisUrl) ?? 6380,
    grpc: Number(hostPort.split(":")[1]) || 7077,
    dash: Number(getEnv(env, "HATCHET_DASHBOARD_PORT")) || 8888,
    app: Number(getEnv(env, "PORT")) || 3002,
  };

  // If our own stack is already up, its containers own these ports — leave them.
  if (run("docker", ["compose", "ps", "-q"]).stdout.length > 0) {
    ok("Containers already running — keeping current ports");
    return want;
  }

  const taken = new Set<number>();
  const got: Ports = { ...want };
  const remaps: string[] = [];
  // `app` is remapped too: 3002 is a popular dev port, and without this a
  // fresh scaffold on a machine where it's taken EADDRINUSEs on first
  // `pnpm dev` (the very failure bootstrap exists to prevent).
  for (const key of ["pg", "redis", "grpc", "dash", "app"] as const) {
    const desired = want[key];
    if (!taken.has(desired) && (await isPortFree(desired))) {
      taken.add(desired);
      continue;
    }
    const free = await findFreePort(desired + 1, taken);
    got[key] = free;
    remaps.push(`${key} ${desired}→${free}`);
  }

  if (remaps.length === 0) {
    ok("All default ports are free");
    return got;
  }

  warn(`Ports in use — remapped: ${remaps.join(", ")}`);
  syncEnvPorts(got);
  info("Synced host ports into .env (Docker Compose reads them)");
  // A minted token embeds the gRPC broadcast address; a port change makes an
  // existing token stale (ensureHatchetToken keeps a real token as-is).
  if (got.grpc !== want.grpc) {
    const token = getEnv(env, "HATCHET_CLIENT_TOKEN") ?? "";
    if (token.split(".").length === 3) {
      warn(
        "gRPC port changed — re-mint your Hatchet token (the old one targets the old port).",
      );
    }
  }
  return got;
}

/**
 * Persist the chosen ports to `.env`. The compose file interpolates the
 * `*_PORT` vars (`${POSTGRES_PORT:-5434}` etc.) and the app reads the URLs —
 * so a single `.env` is the source of truth for both, with no override file.
 */
function syncEnvPorts(got: Ports): void {
  let env = readFileSync(ENV_PATH, "utf8");
  const dbUrl = getEnv(env, "DATABASE_URL");
  const redisUrl = getEnv(env, "REDIS_URL");
  if (dbUrl) env = setEnv(env, "DATABASE_URL", withPort(dbUrl, got.pg));
  if (redisUrl) env = setEnv(env, "REDIS_URL", withPort(redisUrl, got.redis));
  env = setEnv(env, "HATCHET_CLIENT_HOST_PORT", `localhost:${got.grpc}`);
  // Compose-only port vars (consumed by docker-compose.yml interpolation).
  env = setEnv(env, "POSTGRES_PORT", String(got.pg));
  env = setEnv(env, "REDIS_PORT", String(got.redis));
  env = setEnv(env, "HATCHET_DASHBOARD_PORT", String(got.dash));
  env = setEnv(env, "HATCHET_GRPC_PORT", String(got.grpc));
  // The app's own port — API_PUBLIC_URL embeds it (tracking/unsubscribe links,
  // the data-plane client base), so both must move together. So must
  // HOGSEND_API_URL: the `hogsend` CLI targets it (default localhost:3002),
  // and after a remap the default would point the CLI at whatever foreign
  // process caused the remap in the first place.
  env = setEnv(env, "PORT", String(got.app));
  const publicUrl = getEnv(env, "API_PUBLIC_URL");
  if (publicUrl) {
    env = setEnv(env, "API_PUBLIC_URL", withPort(publicUrl, got.app));
  }
  env = setEnv(env, "HOGSEND_API_URL", `http://localhost:${got.app}`);
  writeFileSync(ENV_PATH, env);
}

// --- 4. docker up ----------------------------------------------------------
function dockerUp(): void {
  info("docker compose up -d --wait (first run pulls images — be patient)");
  const status = runLive("docker", [
    "compose",
    "up",
    "-d",
    "--wait",
    "--wait-timeout",
    "180",
  ]);
  if (status !== 0) {
    die(
      "Containers failed to start.",
      `Check \`docker compose logs\`, then re-run \`${pmRun("bootstrap")}\`.`,
    );
  }
  ok("Postgres, Redis and Hatchet-Lite are up");
}

// --- 5. hatchet token ------------------------------------------------------
function hatchetTenantId(): string {
  const r = run("docker", [
    "compose",
    "exec",
    "-T",
    "hatchet-lite",
    "cat",
    "/config/server.yaml",
  ]);
  const m = r.stdout.match(/defaultTenantId:\s*([0-9a-f-]+)/);
  return m?.[1] ?? DEFAULT_HATCHET_TENANT;
}

function mintToken(tenantId: string): string | null {
  const r = run("docker", [
    "compose",
    "exec",
    "-T",
    "hatchet-lite",
    "/hatchet-admin",
    "token",
    "create",
    "--config",
    "/config",
    "--tenant-id",
    tenantId,
    "--name",
    PROJECT,
  ]);
  // The JWT is the only stdout line; logs go to stderr.
  const token = r.stdout.split("\n").pop()?.trim() ?? "";
  return r.status === 0 && token.split(".").length === 3 ? token : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

async function ensureHatchetToken(): Promise<void> {
  const env = readFileSync(ENV_PATH, "utf8");
  const current = getEnv(env, "HATCHET_CLIENT_TOKEN") ?? "";
  if (current.split(".").length === 3) {
    ok("HATCHET_CLIENT_TOKEN already set — keeping it");
    return;
  }

  const tenantId = hatchetTenantId();
  // Try once eagerly — if Hatchet is already initialized the token mints
  // immediately and we never start a spinner (no spinner flash on the happy path).
  let token = mintToken(tenantId);
  if (!token) {
    const stop = startSpinner("Waiting for Hatchet to finish initializing…");
    for (let attempt = 2; attempt <= 20 && !token; attempt += 1) {
      await sleep(2000);
      token = mintToken(tenantId);
    }
    stop(); // stop BEFORE printing ok()/die() so the spinner line is gone.
  }
  if (!token) {
    die(
      "Couldn't mint a Hatchet token after ~40s.",
      "Open the dashboard, create one manually, and set HATCHET_CLIENT_TOKEN in .env.",
    );
  }

  writeFileSync(
    ENV_PATH,
    setEnv(readFileSync(ENV_PATH, "utf8"), "HATCHET_CLIENT_TOKEN", token),
  );
  ok("Minted a Hatchet API token → .env");
}

// --- 6. migrations ---------------------------------------------------------
async function runMigrations(): Promise<void> {
  info(`${pmRun("db:migrate")} (engine track, then client track)`);
  const status = runLive(
    PM,
    ["run", "db:migrate"],
    process.platform === "win32",
  );
  if (status !== 0) {
    die(
      "Migrations failed.",
      `Check the output above, then re-run \`${pmRun("bootstrap")}\`.`,
    );
  }
  await verifyEngineSchema();
  ok("Database migrated");
}

/**
 * Prove the ENGINE migration track actually reached HEAD — the same probe the
 * API's boot guard runs, so bootstrap's "✓ Ready." and `dev` booting can never
 * disagree. Guards against any regression where `db:migrate` exits 0 while the
 * engine track was skipped (e.g. the old percent-encoded-path bug): every later
 * step (api_keys mint, Studio admin, `dev` itself) needs the engine schema.
 */
async function verifyEngineSchema(): Promise<void> {
  const databaseUrl = getEnv(readFileSync(ENV_PATH, "utf8"), "DATABASE_URL");
  if (!databaseUrl) return; // db:migrate itself would have failed without it
  const [{ default: postgres }, { drizzle }, { getEngineSchemaVersion }] =
    await Promise.all([
      import("postgres"),
      import("drizzle-orm/postgres-js"),
      import("@hogsend/db"),
    ]);
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    const version = await getEngineSchemaVersion(drizzle(sql));
    if (!version.inSync) {
      die(
        `Engine schema is still behind after db:migrate — ${version.pending.length} migration(s) pending (next: ${version.pending[0]}).`,
        "The engine migration track did not apply. Please report this: https://github.com/dougwithseismic/hogsend/issues",
      );
    }
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

// --- 7. api keys (data-plane + admin) --------------------------------------
/**
 * Mint the two local API keys and write them to `.env`:
 *
 *   - `HOGSEND_API_KEY` — `ingest` scope. Authenticates your own app code via
 *     the `@hogsend/client` instance in `src/lib/hogsend.ts` (PUT /v1/contacts,
 *     POST /v1/events, POST /v1/emails, /v1/lists).
 *   - `HOGSEND_ADMIN_KEY` — `full-admin` scope. What the `hogsend` CLI reads
 *     for admin commands (`hogsend connect posthog`, stats, webhooks, ...), so
 *     they work out of the box against the local instance.
 *
 * Mirrors the engine's `generateApiKey`/`hashApiKey` (sha256 hex of the raw
 * `hsk_` key; only the hash is stored). Idempotent per key: a real `hsk_` value
 * already in `.env` is kept as-is (re-running never creates a duplicate). If
 * the DB is unreachable it records an issue and continues — the rest of the
 * stack is up, and re-running `bootstrap` retries.
 */
async function ensureApiKeys(): Promise<void> {
  const specs = [
    {
      envKey: "HOGSEND_API_KEY",
      scopes: ["ingest"],
      name: "local-bootstrap",
      blurb: "an ingest-scoped data-plane key",
    },
    {
      envKey: "HOGSEND_ADMIN_KEY",
      scopes: ["full-admin"],
      name: "local-bootstrap-admin",
      blurb: "a full-admin key (hogsend CLI / Studio API)",
    },
  ];
  let envContent = readFileSync(ENV_PATH, "utf8");
  const pending: typeof specs = [];
  for (const spec of specs) {
    if ((getEnv(envContent, spec.envKey) ?? "").startsWith("hsk_")) {
      ok(`${spec.envKey} already set — keeping it`);
    } else {
      pending.push(spec);
    }
  }
  if (pending.length === 0) return;

  const databaseUrl = getEnv(envContent, "DATABASE_URL");
  if (!databaseUrl) {
    issue("DATABASE_URL is not set in .env — skipping API key mint.");
    return;
  }

  // Dynamic imports: runtime deps only this step needs, so a non-DB bootstrap
  // path never pays for them. `generateApiKey` is the ENGINE's own generator
  // (hsk_ + 8-char prefix + sha256-hex at rest) via its dependency-free
  // subpath — the same shape the API's auth lookup verifies, so the key
  // format can never drift from the engine that checks it. Any failure
  // (module/connection) is an issue-not-die — the stack is otherwise usable.
  let sql: import("postgres").Sql | undefined;
  try {
    const [{ default: postgres }, { generateApiKey }] = await Promise.all([
      import("postgres"),
      import("@hogsend/engine/api-key-hash"),
    ]);
    sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
    for (const spec of pending) {
      const { key, prefix, hash } = generateApiKey();
      await sql`
        INSERT INTO api_keys (name, key_prefix, key_hash, scopes)
        VALUES (
          ${spec.name},
          ${prefix},
          ${hash},
          ${JSON.stringify(spec.scopes)}::jsonb
        )
      `;
      // Per-key write (not batched): key 1 stays persisted in .env even if
      // key 2's insert throws — a re-run then mints only the missing one.
      envContent = setEnv(envContent, spec.envKey, key);
      writeFileSync(ENV_PATH, envContent);
      ok(`Minted ${spec.blurb} → ${spec.envKey} in .env`);
    }
  } catch (err) {
    issue(
      `Couldn't mint API keys: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    info("Is the database reachable? Re-run bootstrap once it is.");
  } finally {
    await sql?.end({ timeout: 5 }).catch(() => {});
  }
}

// --- 8. first Studio admin (optional, interactive) -------------------------
/**
 * Offer to create the first Studio admin. Public sign-up is closed, so the only
 * ways to mint the first admin are this CLI command and the boot-time env
 * bootstrap (`STUDIO_ADMIN_EMAIL`). This step is interactive + skippable: it is
 * a no-op in CI / non-TTY runs and when the operator declines.
 *
 * It shells out to the SAME `studio:admin` wrapper the package.json exposes
 * (`node --env-file=.env node_modules/@hogsend/cli/dist/bin.js studio admin
 * create`), so the CLI sees `DATABASE_URL` + `BETTER_AUTH_SECRET` from `.env` —
 * exactly how `dev` loads its env. The masked password prompt is the CLI's own
 * (stdio inherited).
 */
async function bootstrapAdmin(): Promise<void> {
  const env = readFileSync(ENV_PATH, "utf8");

  // If env-bootstrap is already configured, the API mints the admin on boot —
  // don't double-create here.
  const adminEmail = getEnv(env, "STUDIO_ADMIN_EMAIL");
  if (adminEmail && !adminEmail.startsWith("#")) {
    ok(
      `STUDIO_ADMIN_EMAIL is set (${adminEmail}) — the API mints it on first boot (${pmRun("dev")})`,
    );
    info(
      "No STUDIO_ADMIN_PASSWORD? One is generated and printed ONCE in the boot log.",
    );
    info(`Or run \`${pmRun("studio:admin")}\` to create one now.`);
    return;
  }

  if (!process.stdin.isTTY) {
    info("No TTY — skipping admin create.");
    info(
      `Create one later: \`${pmRun("studio:admin")}\`, set STUDIO_ADMIN_EMAIL ` +
        "in .env, or scaffold with `create-hogsend --admin-email`.",
    );
    return;
  }

  const wanted = await confirm("Create your first Studio admin now?", false);
  if (!wanted) {
    info(
      `Skipped. Create one later: \`${pmRun("studio:admin")}\` ` +
        "(or set STUDIO_ADMIN_EMAIL in .env).",
    );
    return;
  }

  // Reuse the exact env-loading the `studio:admin` script uses. Target the CLI's
  // real ESM entry, NOT `node_modules/.bin/hogsend`: under pnpm/yarn that bin is a
  // POSIX shell shim, so pointing `node` at it makes Node parse shell as JS
  // ("SyntaxError: missing ) after argument list"). `@hogsend/cli`'s bin is
  // `./dist/bin.js`, which resolves identically on npm/pnpm/yarn/bun.
  const status = runLive(
    "node",
    [
      "--env-file=.env",
      join("node_modules", "@hogsend", "cli", "dist", "bin.js"),
      "studio",
      "admin",
      "create",
    ],
    process.platform === "win32",
  );
  if (status !== 0) {
    issue("Admin create did not complete.");
    info(`You can re-run it any time: \`${pmRun("studio:admin")}\`.`);
    return;
  }
  ok("Studio admin created");
}

// --- 9. connect PostHog (optional, interactive) -----------------------------
/**
 * The "one last thing" — run the real `hogsend connect posthog` OAuth flow
 * right here, while everything it needs already exists: the admin key (step 7,
 * read from `.env` by the CLI), a migrated DB, and Docker infra. The flow
 * talks to the instance over HTTP, so if the app isn't running yet we boot it
 * JUST for the handshake and stop it afterwards.
 *
 * Offered only when PostHog was chosen at scaffold time (create-hogsend sets
 * HOGSEND_SETUP_POSTHOG=1) or `.env` already carries PostHog markers — plain
 * re-runs of bootstrap don't nag. Locally this stores the OAuth credential on
 * THIS instance (person reads + outbound capture activate); the PostHog →
 * Hogsend webhook loop needs a publicly reachable URL, so the CLI reports
 * "connected (loop not provisioned)" — after deploy, re-run the connect
 * against the deployed instance to wire the loop.
 */
function shouldOfferPosthog(): boolean {
  if (!process.stdin.isTTY) return false;
  if (process.env.HOGSEND_SETUP_POSTHOG === "1") return true;
  const src = existsSync(ENV_PATH) ? ENV_PATH : ENV_EXAMPLE;
  if (!existsSync(src)) return false;
  const env = readFileSync(src, "utf8");
  return (
    getEnv(env, "ENABLE_POSTHOG_DESTINATION") === "true" ||
    Boolean(getEnv(env, "POSTHOG_HOST"))
  );
}

/**
 * "Is OUR app answering here?" — NOT merely "does something answer?". Port
 * 3002 is a popular dev port: an unrelated app squatting on it happily
 * answers HTTP (a naive probe then skips starting our API and the connect
 * CLI 404s against a stranger), and a DIFFERENT Hogsend instance would be
 * even worse — we'd store the PostHog credential into someone else's
 * database. The probe rules out every foreign responder: an authenticated
 * GET with the admin key minted in step 7, whose 200 body must carry the
 * connect-info shape (`providerId: "posthog"`). A 404-app fails on status, a
 * different Hogsend fails on 401 (it doesn't know our key), and even a
 * blanket-200 server fails the shape check — only OUR instance passes.
 */
async function isOurApi(base: string, adminKey: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}/v1/admin/analytics/connect-info`, {
      headers: { Authorization: `Bearer ${adminKey}` },
      signal: AbortSignal.timeout(1500),
    });
    if (res.status !== 200) return false;
    const body = (await res.json()) as { providerId?: unknown };
    return body?.providerId === "posthog";
  } catch {
    return false;
  }
}

// The temporary API child is DETACHED (own process group, so we can kill the
// whole pm → tsx → node chain in one signal) — which also means a Ctrl-C
// during the OAuth prompts would NOT reach it and bootstrap's death would
// orphan a server on the app's port. These handlers guarantee it dies with
// us, whatever the exit.
let apiChild: ChildProcess | undefined;
function killApiChild(): void {
  if (apiChild?.pid !== undefined) {
    try {
      process.kill(-apiChild.pid, "SIGTERM"); // POSIX: the whole group
    } catch {
      try {
        apiChild.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }
  }
  apiChild = undefined;
}
process.on("exit", killApiChild);
process.on("SIGINT", () => {
  killApiChild();
  process.exit(130);
});
process.on("SIGTERM", () => {
  killApiChild();
  process.exit(143);
});

/** The one connect command every hint interpolates. */
const CONNECT_CMD = pmExec("hogsend connect posthog");

async function connectPosthog(): Promise<void> {
  const env = readFileSync(ENV_PATH, "utf8");
  const configuredPort = Number(getEnv(env, "PORT") ?? "3002");
  const adminKey = getEnv(env, "HOGSEND_ADMIN_KEY") ?? "";
  if (!adminKey.startsWith("hsk_")) {
    // Step 7 mints it; missing means that step failed (already an issue).
    info(
      `No HOGSEND_ADMIN_KEY in .env — re-run bootstrap, then \`${CONNECT_CMD}\`.`,
    );
    return;
  }

  const wanted = await confirm(
    "One last thing — connect PostHog now? (opens your browser to authorize; no keys to paste)",
    true,
  );
  if (!wanted) {
    info(
      `Skipped. Any time: \`${CONNECT_CMD}\` from this folder (app running).`,
    );
    return;
  }

  // Reuse the app ONLY if it's provably ours (see isOurApi); else boot one
  // just for the handshake — on the configured port when it's actually free,
  // else on the next free port (PORT in the child env wins over .env: Node's
  // --env-file never overrides an already-set process env var).
  let base = `http://localhost:${configuredPort}`;
  const reused = await isOurApi(base, adminKey);
  if (!reused) {
    const port = (await isPortFree(configuredPort))
      ? configuredPort
      : await findFreePort(configuredPort + 1, new Set());
    if (port !== configuredPort) {
      info(
        `Port ${configuredPort} is in use by something that isn't this app — using :${port} for the handshake.`,
      );
    }
    base = `http://localhost:${port}`;
    const stop = startSpinner(
      `Starting the API for the handshake (${pmRun("dev")} on :${port})…`,
    );
    apiChild = spawn(PM, ["run", "dev"], {
      cwd: ROOT,
      stdio: "ignore",
      detached: process.platform !== "win32",
      shell: process.platform === "win32",
      env: { ...process.env, PORT: String(port) },
    });
    let up = false;
    for (let i = 0; i < 60 && !up; i += 1) {
      await sleep(1000);
      up = await isOurApi(base, adminKey);
    }
    stop();
    if (!up) {
      killApiChild();
      issue("Couldn't start the API for the PostHog handshake.");
      info(`Start it yourself (${pmRun("dev")}) and run \`${CONNECT_CMD}\`.`);
      return;
    }
  }

  try {
    // Same CLI entry the `studio:admin` wrapper targets (never the .bin shim —
    // see bootstrapAdmin). `--url` pins the instance in case PORT is custom;
    // the admin key comes from the `.env` in cwd (minted in step 7).
    const status = runLive(
      "node",
      [
        join("node_modules", "@hogsend", "cli", "dist", "bin.js"),
        "connect",
        "posthog",
        "--url",
        base,
      ],
      process.platform === "win32",
    );
    if (status !== 0) {
      issue("PostHog connect did not complete.");
      info(
        `Re-run any time: \`${CONNECT_CMD}\` from this folder (app running).`,
      );
    } else {
      ok("PostHog connected to this local instance.");
      info(
        `After deploy, wire the event loop: \`${CONNECT_CMD} --url https://your-instance\`.`,
      );
    }
  } finally {
    if (!reused) killApiChild();
  }
}

// --- orchestration ---------------------------------------------------------
async function main(): Promise<void> {
  process.stdout.write(
    `\n${magenta(bold("◆ Hogsend"))} ${dim("local bootstrap")} ${dim("· docs.hogsend.com")}\n`,
  );

  // Decide the step count up front — the PostHog connect step only exists
  // when it was chosen at scaffold time (or .env already points at PostHog).
  const offerPosthog = shouldOfferPosthog();
  if (offerPosthog) TOTAL = 9;

  step("Checking Docker");
  checkDocker();

  step("Preparing .env");
  ensureEnv();

  step("Resolving ports");
  const ports = await resolvePorts();

  step("Starting containers");
  dockerUp();

  step("Minting Hatchet token");
  await ensureHatchetToken();

  step("Running migrations");
  await runMigrations();

  step("Minting API keys");
  await ensureApiKeys();

  step("Creating your first Studio admin");
  await bootstrapAdmin();

  if (offerPosthog) {
    step("Connecting PostHog (optional)");
    await connectPosthog();
  }

  const dash = `http://localhost:${ports.dash}`;
  const finalEnv = readFileSync(ENV_PATH, "utf8");
  // Studio is served by the API itself at `${API_PUBLIC_URL}/studio`; read the
  // real values from the .env we just wrote so a custom PORT / public URL is
  // honoured (default http://localhost:3002).
  const apiUrl = getEnv(finalEnv, "API_PUBLIC_URL") ?? "http://localhost:3002";
  const apiPort = getEnv(finalEnv, "PORT") ?? "3002";
  const studioUrl = `${apiUrl}/studio`;
  // `connect posthog` needs a reachable instance (PostHog can't hit a localhost
  // webhook), so this is an "After deploy" step — only surface it when the .env
  // already points at PostHog.
  const usingPosthog =
    getEnv(finalEnv, "ENABLE_POSTHOG_DESTINATION") === "true" ||
    Boolean(getEnv(finalEnv, "POSTHOG_HOST"));

  // Aligned `label  url  # note` row for the three onboarding touchpoints.
  const link = (label: string, url: string, note: string): string =>
    `  ${dim(label.padEnd(9))}${cyan(url)}   ${dim(note)}`;

  // An honest banner: "✓ Ready." is reserved for a run where every step
  // actually succeeded. Recorded issues re-surface here (they scrolled past
  // long ago) and flip the exit code so wrappers see the truth.
  const banner =
    issues.length === 0
      ? `\n${green(bold("✓ Ready."))} ${bold("Welcome to Hogsend.")}`
      : [
          `\n${yellow(bold(`! Finished with ${issues.length} issue(s):`))}`,
          ...issues.map((m) => `    ${yellow("•")} ${m}`),
          `  ${dim(`Fix the above and re-run \`${pmRun("bootstrap")}\` — it is safe to re-run.`)}`,
        ].join("\n");

  process.stdout.write(
    [
      banner,
      // The compose stack is only the infra your app talks to — the API and
      // worker are your code and run as host processes (hot-reload), so nothing
      // is serving yet until you start them.
      `  ${dim("Local infra is up (Postgres, Redis, Hatchet) — your app isn't running yet. Start it:")}`,
      "",
      `    ${cyan(pmRun("dev"))}          ${dim(`# API + Studio on :${apiPort}`)}`,
      `    ${cyan(pmRun("worker:dev"))}   ${dim("# Hatchet worker, 2nd terminal — runs your journeys")}`,
      "",
      link("Studio", studioUrl, "# your dashboard (once dev is running)"),
      link(
        "Docs",
        "https://docs.hogsend.com",
        "# guides + first journey: src/journeys/welcome.ts",
      ),
      link(
        "Discord",
        "https://discord.gg/rv6eZNvYrr",
        "# questions, help, and what we're shipping",
      ),
      "",
      `  ${dim("Studio admin:")} ${cyan(pmRun("studio:admin"))}   ${dim("# create one anytime (sign-up is closed)")}`,
      `  ${dim("Hatchet dashboard:")} ${cyan(dash)} ${dim("(admin@example.com / Admin123!!)")}`,
      usingPosthog
        ? `  ${dim("After deploy:")} ${cyan(`${CONNECT_CMD} --url https://your-instance`)}   ${dim("# wire the PostHog→Hogsend event loop")}`
        : null,
      "",
    ]
      .filter(Boolean)
      .join("\n"),
  );

  if (issues.length > 0) process.exit(1);
}

main().catch((err: unknown) => {
  die(err instanceof Error ? err.message : String(err));
});
