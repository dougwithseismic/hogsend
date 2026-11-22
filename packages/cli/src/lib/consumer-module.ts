import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Helpers for importing a consumer app's TypeScript modules (journeys, flags)
 * in a child process under the app's own `tsx`, so `@hogsend/*` resolves from
 * the app's node_modules rather than the CLI bundle.
 */

/**
 * Resolve a `tsx` binary: the nearest `node_modules/.bin/tsx` at or above the
 * app root (covers workspace-hoisted installs), then the CLI package's own.
 */
export function resolveTsxBin(consumerRoot: string): string {
  let dir = consumerRoot;
  for (;;) {
    const shim = join(dir, "node_modules", ".bin", "tsx");
    if (existsSync(shim)) return shim;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fall back to the CLI package's own tsx (bundled as a devDependency).
  const own = join(dirname(dirname(dirname(import.meta.dirname))), "cli");
  const ownShim = join(own, "node_modules", ".bin", "tsx");
  if (existsSync(ownShim)) return ownShim;
  throw new Error(
    "could not find a `tsx` binary — install it in the app (pnpm add -D tsx)",
  );
}

/**
 * Resolve tsx's ESM loader (`tsx` package entry, `dist/loader.mjs`) as a file
 * URL for `node --import`: from the app first (covers workspace-hoisted
 * installs), then the CLI's own copy. Running node directly instead of the
 * `.bin/tsx` shim means no wrapper process, so signals and a kill reach the
 * process that runs the journeys.
 */
export function resolveTsxLoader(consumerRoot: string): string {
  const candidates = [
    createRequire(join(consumerRoot, "package.json")),
    createRequire(import.meta.url),
  ];
  for (const require of candidates) {
    try {
      return pathToFileURL(require.resolve("tsx")).href;
    } catch {
      // try the next location
    }
  }
  throw new Error(
    "could not find `tsx` — install it in the app (pnpm add -D tsx)",
  );
}

/**
 * A syntactically-valid dummy Hatchet JWT (header.payload.sig) carrying the
 * claims the SDK reads at `HatchetClient.init` (`sub` + server/grpc addresses).
 * Never used for a real connection — callers only import the module graph.
 */
export function makePlaceholderJwt(): string {
  const b64 = (obj: unknown): string =>
    Buffer.from(JSON.stringify(obj)).toString("base64url");
  const header = b64({ alg: "none", typ: "JWT" });
  const payload = b64({
    sub: "hogsend-flags-codegen",
    server_url: "https://localhost",
    grpc_broadcast_address: "localhost:7077",
  });
  return `${header}.${payload}.placeholder`;
}

/**
 * Environment for a child that only imports the app's module graph. Importing
 * a module that loads the main `@hogsend/engine` entry validates its env and
 * builds a Hatchet client at import time, so supply benign placeholders. Any
 * real value already in the environment still wins. Nothing is dialled: the
 * database and Redis clients connect lazily, and the Hatchet token is a
 * well-formed dummy JWT with the insecure TLS path forced.
 */
export function placeholderEnv(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...base,
    DATABASE_URL:
      base.DATABASE_URL ??
      "postgresql://placeholder:placeholder@localhost:5432/placeholder",
    BETTER_AUTH_SECRET:
      base.BETTER_AUTH_SECRET ?? "hogsend-flags-codegen-placeholder-secret",
    HATCHET_CLIENT_TOKEN: base.HATCHET_CLIENT_TOKEN ?? makePlaceholderJwt(),
    HATCHET_CLIENT_TLS_STRATEGY: base.HATCHET_CLIENT_TLS_STRATEGY ?? "none",
  };
}

/**
 * Variables the simulation child inherits from the parent: what node, tsx and
 * the OS need to run. Matched case-insensitively (Windows env names are).
 * Everything else is dropped, including NODE_OPTIONS.
 */
const SIMULATE_PASSTHROUGH = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "TERM",
  "LOG_LEVEL",
  // Windows
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
]);

/** Hosts under `.invalid` never resolve, so a stray connect fails at once. */
const SIMULATE_PLACEHOLDERS = {
  DATABASE_URL:
    "postgresql://placeholder:placeholder@placeholder.invalid:5432/placeholder",
  REDIS_URL: "redis://placeholder.invalid:6379",
  BETTER_AUTH_SECRET: "hogsend-simulate-placeholder-secret-000000",
  HATCHET_CLIENT_TLS_STRATEGY: "none",
} as const;

/**
 * Environment for the `hogsend simulate` child. Unlike {@link placeholderEnv}
 * it starts from a clean slate: provider credentials (PostHog, Resend,
 * Postmark, Twilio, connector tokens, webhook secrets, AI keys) never reach
 * the journeys, even when the parent shell has them, and the database, Redis
 * and Hatchet settings are always placeholders. A simulation therefore cannot
 * capture to a real analytics project or reach a real service, whatever the
 * journeys import.
 */
export function simulateEnv(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (SIMULATE_PASSTHROUGH.has(upper) || upper.startsWith("LC_")) {
      env[key] = value;
    }
  }
  return {
    ...env,
    LOG_LEVEL: env.LOG_LEVEL ?? "error",
    ...SIMULATE_PLACEHOLDERS,
    HATCHET_CLIENT_TOKEN: makePlaceholderJwt(),
  };
}
