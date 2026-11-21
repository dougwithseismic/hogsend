import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { JourneySimulation } from "@hogsend/testing";
import { resolveTsxLoader, simulateEnv } from "./consumer-module.js";
import type { SimulationRun } from "./simulate-args.js";

/**
 * Runs simulations inside the consumer app. The journeys and `@hogsend/testing`
 * must share one `@hogsend/engine` module instance (the harness hooks the
 * engine's journey boundary), so the work happens in a child process
 * (`node --import tsx`), with every `@hogsend/*` import resolved from the app.
 * The child gets a clean environment (see `simulateEnv`), a wall-clock limit,
 * and the parent's SIGINT/SIGTERM.
 */

export interface SimulateRunnerOptions {
  /** Consumer app root (the directory holding its package.json). */
  appRoot: string;
  /** Absolute path to the module exporting the `journeys` array. */
  journeysPath: string;
  /** Load `src/emails/registry.ts` / `src/sms/registry.ts` when present. */
  templates: boolean;
  /** Simulate even when the enrollment guards would skip the user. */
  force: boolean;
  runs: SimulationRun[];
  /** Wall-clock limit for the child, in ms (default 60s). */
  timeoutMs?: number;
}

/** A run the child could not simulate (bad scenario input, setup error). */
export interface SimulationRunError {
  source: string;
  journeyId: string;
  message: string;
}

export interface SimulationResults {
  /** Reports for the runs that completed, in run order. */
  simulations: JourneySimulation[];
  /** Runs that threw before producing a report, in run order. */
  errors: SimulationRunError[];
}

const DEFAULT_TIMEOUT_MS = 60_000;
/** After a forwarded signal, how long the child gets before SIGKILL. */
const KILL_GRACE_MS = 2_000;

const EMAIL_REGISTRY = join("src", "emails", "registry.ts");
const SMS_REGISTRY = join("src", "sms", "registry.ts");

const packageVersion = (packageJson: string): string => {
  try {
    const parsed = JSON.parse(readFileSync(packageJson, "utf8")) as {
      version?: string;
    };
    return parsed.version ?? "unknown";
  } catch {
    return "unknown";
  }
};

/**
 * Resolve `@hogsend/testing` from the app and check that it shares the app's
 * `@hogsend/engine`. Two engine copies would give the harness a different
 * journey boundary from the one the journeys call into.
 */
export function resolveTestingEntry(appRoot: string): string {
  const appRequire = createRequire(join(appRoot, "package.json"));
  let entry: string;
  try {
    entry = appRequire.resolve("@hogsend/testing");
  } catch {
    throw new Error(
      `@hogsend/testing is not installed in ${appRoot}. simulate runs journeys through it: pnpm add -D @hogsend/testing`,
    );
  }
  let appEngine: string;
  let testingEngine: string;
  try {
    appEngine = realpathSync(
      appRequire.resolve("@hogsend/engine/package.json"),
    );
    testingEngine = realpathSync(
      createRequire(entry).resolve("@hogsend/engine/package.json"),
    );
  } catch {
    // An engine without an exported package.json cannot be compared; the
    // child run still surfaces a mismatch as a journey error.
    return entry;
  }
  if (appEngine !== testingEngine) {
    const appVersion = packageVersion(appEngine);
    const testingVersion = packageVersion(testingEngine);
    throw new Error(
      [
        "@hogsend/testing resolves a different @hogsend/engine from the app:",
        `  app:     ${appVersion} (${dirname(appEngine)})`,
        `  testing: ${testingVersion} (${dirname(testingEngine)})`,
        `Install the matching version: pnpm add -D @hogsend/testing@${appVersion}`,
      ].join("\n"),
    );
  }
  return entry;
}

/**
 * The child script. It reads its config from a JSON file, imports the app's
 * journeys and templates, runs each simulation and writes the results to a
 * file, so anything the journeys or the engine print cannot corrupt them.
 */
const LOADER = `import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const configFile = process.argv[2];
// The parent holds an IPC channel open; if it dies without cleaning up, the
// channel closes, so remove the temp dir and stop.
process.on("disconnect", () => {
  rmSync(dirname(configFile), { recursive: true, force: true });
  process.exit(1);
});
const config = JSON.parse(readFileSync(configFile, "utf8"));
const result = {};
const pick = (mod, name) =>
  mod && mod[name] !== undefined ? mod[name] : mod ? mod.default : undefined;

try {
  const testing = await import(config.testingUrl);
  if (typeof testing.simulateJourney !== "function") {
    result.error = {
      code: "testing_outdated",
      message:
        "the installed @hogsend/testing has no simulateJourney(); upgrade it to the same version as @hogsend/cli",
    };
  } else {
    const mod = await import(config.journeysUrl);
    const journeys = pick(mod, "journeys");
    if (!Array.isArray(journeys)) {
      result.error = {
        code: "no_journeys",
        message: config.journeysPath + " does not export a \`journeys\` array",
      };
    } else {
      const byId = new Map();
      for (const journey of journeys) {
        if (journey && journey.meta && typeof journey.meta.id === "string") {
          byId.set(journey.meta.id, journey);
        }
      }
      const missing = [
        ...new Set(config.runs.map((run) => run.journeyId)),
      ].filter((id) => !byId.has(id));
      if (missing.length > 0) {
        result.error = {
          code: "unknown_journey",
          missing,
          available: [...byId.keys()].sort(),
        };
      } else {
        const templates = config.templatesUrl
          ? pick(await import(config.templatesUrl), "templates")
          : undefined;
        const smsTemplates = config.smsTemplatesUrl
          ? pick(await import(config.smsTemplatesUrl), "smsTemplates")
          : undefined;
        // One bad scenario must not hide the others, so errors are per run.
        result.runs = [];
        for (const run of config.runs) {
          try {
            result.runs.push({
              simulation: await testing.simulateJourney(
                byId.get(run.journeyId),
                {
                  ...run.scenario,
                  ...(templates ? { templates } : {}),
                  ...(smsTemplates ? { smsTemplates } : {}),
                },
                { force: config.force },
              ),
            });
          } catch (error) {
            result.runs.push({
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
    }
  }
} catch (error) {
  result.error = {
    code: "exception",
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  };
}

writeFileSync(config.outFile, JSON.stringify(result));
process.exit(0);
`;

interface LoaderResult {
  /** One entry per config run, in order. */
  runs?: Array<{ simulation?: JourneySimulation; error?: string }>;
  error?: {
    code: string;
    message?: string;
    stack?: string;
    missing?: string[];
    available?: string[];
  };
}

interface ChildOutcome {
  status: number | null;
  output: string;
  /** The wall-clock limit was hit and the child was killed. */
  timedOut: boolean;
  /** The parent received this signal and forwarded it to the child. */
  interrupted?: NodeJS.Signals;
}

/**
 * Run `node <args>` with a wall-clock limit. SIGINT/SIGTERM received by the
 * parent are forwarded to the child (SIGKILL follows after a short grace),
 * and the child is killed if the parent exits first.
 */
function runChild(
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<ChildOutcome> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let output = "";
    let timedOut = false;
    let interrupted: NodeJS.Signals | undefined;
    const collect = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > 200_000) output = output.slice(-100_000);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);
    const forward = (signal: NodeJS.Signals) => {
      interrupted = signal;
      child.kill(signal);
      setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
    };
    const onSigint = () => forward("SIGINT");
    const onSigterm = () => forward("SIGTERM");
    const onExit = () => child.kill("SIGKILL");
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
    process.on("exit", onExit);
    const cleanup = () => {
      clearTimeout(timer);
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      process.off("exit", onExit);
    };

    child.on("error", (error) => {
      cleanup();
      child.kill("SIGKILL");
      reject(error);
    });
    child.on("close", (status) => {
      cleanup();
      resolvePromise({
        status,
        output,
        timedOut,
        ...(interrupted ? { interrupted } : {}),
      });
    });
  });
}

const describeLoaderError = (
  error: NonNullable<LoaderResult["error"]>,
): string => {
  if (error.code === "unknown_journey") {
    const missing = (error.missing ?? []).map((id) => `"${id}"`).join(", ");
    const available = error.available ?? [];
    return `unknown journey ${missing}. ${
      available.length
        ? `Available: ${available.join(", ")}`
        : "The journeys array is empty."
    }`;
  }
  if (error.code === "exception") {
    return `failed to load the app's journeys: ${error.message ?? "unknown error"}${
      error.stack ? `\n${error.stack}` : ""
    }`;
  }
  return error.message ?? error.code;
};

/**
 * Simulate every run in one child process. Returns the reports in run order,
 * plus the runs that threw before producing a report. Throws when the app
 * cannot be loaded, the child is stopped by the wall-clock limit, or it
 * exits without a result.
 */
export async function runSimulations(
  options: SimulateRunnerOptions,
): Promise<SimulationResults> {
  const testingEntry = resolveTestingEntry(options.appRoot);
  const tsxLoader = resolveTsxLoader(options.appRoot);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const registry = (relative: string): string | undefined => {
    if (!options.templates) return undefined;
    const path = join(options.appRoot, relative);
    return existsSync(path) ? pathToFileURL(path).href : undefined;
  };

  const dir = mkdtempSync(join(tmpdir(), "hogsend-simulate-"));
  const removeDir = () => rmSync(dir, { recursive: true, force: true });
  // Also clean up if the parent exits before the finally below runs.
  process.on("exit", removeDir);
  const loaderFile = join(dir, "simulate.mjs");
  const configFile = join(dir, "config.json");
  const outFile = join(dir, "result.json");
  let interrupted: NodeJS.Signals | undefined;
  try {
    writeFileSync(loaderFile, LOADER, "utf8");
    writeFileSync(
      configFile,
      JSON.stringify({
        testingUrl: pathToFileURL(testingEntry).href,
        journeysUrl: pathToFileURL(options.journeysPath).href,
        journeysPath: options.journeysPath,
        templatesUrl: registry(EMAIL_REGISTRY),
        smsTemplatesUrl: registry(SMS_REGISTRY),
        force: options.force,
        runs: options.runs,
        outFile,
      }),
      "utf8",
    );
    // The journeys import the app's module graph, which can load the main
    // engine entry and validate its env. The child gets a clean env with
    // placeholders for that: no credential from this shell reaches it,
    // nothing is dialled, and the app's .env is never read.
    const child = await runChild(
      ["--import", tsxLoader, loaderFile, configFile],
      { cwd: options.appRoot, env: simulateEnv(), timeoutMs },
    );
    if (child.interrupted) {
      interrupted = child.interrupted;
      throw new Error(`simulation interrupted (${child.interrupted})`);
    }
    if (child.timedOut) {
      const seconds = Math.round(timeoutMs / 100) / 10;
      throw new Error(
        `the simulation did not finish within ${seconds}s (wall clock) and was stopped. A journey that loops without awaiting a ctx wait can spin forever; raise the limit with --timeout <seconds> if the app is just slow to load`,
      );
    }
    if (!existsSync(outFile)) {
      const detail = child.output.trim();
      throw new Error(
        `the simulation process exited (code ${child.status}) without a result${
          detail ? `\n${detail}` : ""
        }`,
      );
    }
    const result = JSON.parse(readFileSync(outFile, "utf8")) as LoaderResult;
    if (result.error) throw new Error(describeLoaderError(result.error));
    const simulations: JourneySimulation[] = [];
    const errors: SimulationRunError[] = [];
    (result.runs ?? []).forEach((entry, index) => {
      const run = options.runs[index];
      if (entry.simulation) simulations.push(entry.simulation);
      else {
        errors.push({
          source: run?.source ?? `run ${index + 1}`,
          journeyId: run?.journeyId ?? "unknown",
          message: entry.error ?? "unknown error",
        });
      }
    });
    return { simulations, errors };
  } finally {
    process.off("exit", removeDir);
    removeDir();
    // Exit the way an interrupted process conventionally does (128 + signo)
    // once the child is gone and the temp dir removed.
    if (interrupted) process.exit(interrupted === "SIGINT" ? 130 : 143);
  }
}
