import { createRequire } from "node:module";
import color from "picocolors";
import type { HogsendClient } from "../container.js";
import { API_VERSION } from "../env.js";

/**
 * Engine-owned boot output. ONE place renders the "we're up" message for the
 * API and the worker, so every scaffolded `create-hogsend` app gets the same
 * polished startup for free — the entry points just call these.
 *
 * Two modes, picked from the environment (never a flag):
 *  - banner: a branded, minimal box (the `create-hogsend` look — magenta badge,
 *    ✓ checks, cyan links) printed straight to stdout. Only when stdout is a TTY
 *    AND `NODE_ENV === "development"`, i.e. an interactive `pnpm dev`.
 *  - structured: a single `logger.info("… ready", { … })` line. Everywhere else
 *    (production, CI, piped output, tests) so log scraping stays intact.
 *
 * The scattered `registry loaded` / `studio mounted` / `server running` lines
 * are demoted to `debug`; this banner is the single source of truth on boot.
 */

// Last-resort value when the runtime manifest read below fails (e.g. a pruned
// node_modules behind a bundler). The read is authoritative in every normal dev
// run and deploy, so this is effectively never hit — `"unknown"` keeps it honest
// rather than risking a stale hard-coded version slipping into structured logs.
const FALLBACK_ENGINE_VERSION = "unknown";

// Conventional Vite dev-server origin for the Studio package (`pnpm dev` starts
// it). In production the Studio is served by the API at `${API_PUBLIC_URL}/studio`.
const STUDIO_DEV_URL = "http://localhost:5173";
const DOCS_URL = "https://docs.hogsend.com";

let cachedEngineVersion: string | undefined;

/** The running `@hogsend/engine` package version (e.g. "0.4.0"). */
export function getEngineVersion(): string {
  if (cachedEngineVersion) return cachedEngineVersion;
  try {
    // Resolve the engine's own manifest from the consumer's module graph —
    // correct under tsx (workspace symlink) and a bundled deploy alike. Needs
    // `"./package.json"` in this package's `exports`.
    const require = createRequire(import.meta.url);
    const pkg = require("@hogsend/engine/package.json") as { version?: string };
    cachedEngineVersion = pkg.version ?? FALLBACK_ENGINE_VERSION;
  } catch {
    cachedEngineVersion = FALLBACK_ENGINE_VERSION;
  }
  return cachedEngineVersion;
}

const BADGE = color.bgMagenta(color.black(" hogsend "));

/** Interactive `pnpm dev` in a real terminal — the only place the banner shows. */
function bannerMode(client: HogsendClient): boolean {
  return Boolean(process.stdout.isTTY) && client.env.NODE_ENV === "development";
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function writeBanner(lines: (string | null)[]): void {
  const body = lines.filter((l): l is string => l !== null).join("\n");
  process.stdout.write(`\n${body}\n\n`);
}

export interface ApiReadyInfo {
  client: HogsendClient;
  /** The port the HTTP server bound to. */
  port: number;
  /** Applied engine-track schema version, when the boot guard ran. */
  schemaVersion?: string | null;
}

/** Render the API "ready" output (banner in dev TTY, structured log otherwise). */
export function reportApiReady(info: ApiReadyInfo): void {
  const { client, port } = info;
  const engineVersion = getEngineVersion();
  const journeys = client.registry.count();
  const buckets = client.bucketRegistry.count();
  const templates = Object.keys(client.templates).length;
  const localUrl = `http://localhost:${port}`;

  // Cache-only, sync, never throws — so reading it here adds no boot latency.
  // Loud when env-flag-forced (resolves even with a cold cache); the
  // domain-unverified auto banner is additionally fired as a transition WARN by
  // the warm-up refresh in the container.
  const testMode = client.domainStatus.testModeCached();

  if (!bannerMode(client)) {
    client.logger.info("Hogsend API ready", {
      engineVersion,
      apiVersion: API_VERSION,
      port,
      url: client.env.API_PUBLIC_URL,
      journeys,
      buckets,
      templates,
      schema: info.schemaVersion ?? undefined,
      ...(testMode.active
        ? {
            testMode: {
              redirectTo: testMode.redirectTo,
              reason: testMode.reason,
            },
          }
        : {}),
    });
    return;
  }

  const dim = color.dim;
  const ok = color.green("✓");
  const loaded = [
    plural(journeys, "journey"),
    plural(buckets, "bucket"),
    plural(templates, "template"),
  ].join(dim(" · "));
  const label = (text: string) => dim(text.padEnd(7));

  const testModeLine = testMode.active
    ? `  ${color.bgYellow(color.black(" TEST MODE "))} ${color.yellow(
        `all sends → ${testMode.redirectTo ?? "(no redirect address — sends will fail!)"} ` +
          dim(`(${testMode.reason ?? "unknown"})`),
      )}`
    : null;

  writeBanner([
    `${BADGE} ${dim(`engine ${engineVersion} · api ${API_VERSION}`)}`,
    "",
    `  ${ok} ${loaded}`,
    info.schemaVersion
      ? `  ${ok} schema in sync ${dim(`(${info.schemaVersion})`)}`
      : null,
    testModeLine,
    "",
    `  ${label("API")}${color.cyan(localUrl)}`,
    `  ${label("Docs")}${color.cyan(`${localUrl}/docs`)}`,
    `  ${label("Studio")}${color.cyan(STUDIO_DEV_URL)}`,
    `  ${label("Guides")}${color.cyan(DOCS_URL)}`,
    "",
    `  ${dim("Next")}  fire a test event in ${color.cyan("Studio › Debug")} ${dim("·")} run the worker: ${color.cyan("pnpm worker:dev")}`,
  ]);
}

export interface WorkerReadyInfo {
  client: HogsendClient;
  journeyTasks: number;
  bucketTasks: number;
  /** Reaction journey tasks generated by `bucket.on()` (Section 9). */
  bucketReactionTasks: number;
  builtinTasks: number;
}

/** Render the worker "ready" output (banner in dev TTY, structured log otherwise). */
export function reportWorkerReady(info: WorkerReadyInfo): void {
  const {
    client,
    journeyTasks,
    bucketTasks,
    bucketReactionTasks,
    builtinTasks,
  } = info;
  const engineVersion = getEngineVersion();
  const hatchetHost = client.env.HATCHET_CLIENT_HOST_PORT;

  if (!bannerMode(client)) {
    client.logger.info("Hogsend worker ready", {
      engineVersion,
      hatchet: hatchetHost,
      namespace: client.env.HATCHET_CLIENT_NAMESPACE || undefined,
      journeyTasks,
      bucketTasks,
      bucketReactionTasks,
      builtinTasks,
    });
    return;
  }

  const dim = color.dim;
  const ok = color.green("✓");
  const tasks = [
    plural(journeyTasks, "journey task"),
    plural(bucketTasks, "bucket task"),
    plural(bucketReactionTasks, "reaction task"),
    plural(builtinTasks, "built-in task"),
  ].join(dim(" · "));

  writeBanner([
    `${BADGE} ${dim(`worker · engine ${engineVersion}`)}`,
    "",
    `  ${ok} registered on Hatchet ${dim(`(${hatchetHost})`)}`,
    `  ${ok} ${tasks}`,
    "",
    `  ${dim("Listening — journeys fire as events arrive.")}`,
    `  ${dim("Send one:")} ${color.cyan("POST /v1/events")} ${dim("· or Studio › Debug")}`,
  ]);
}
