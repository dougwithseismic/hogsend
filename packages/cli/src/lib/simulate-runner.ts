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
import { placeholderEnv, resolveTsxBin } from "./consumer-module.js";
import type { SimulationRun } from "./simulate-args.js";

/**
 * Runs simulations inside the consumer app. The journeys and `@hogsend/testing`
 * must share one `@hogsend/engine` module instance (the harness hooks the
 * engine's journey boundary), so the work happens in a child process under the
 * app's own `tsx`, with every `@hogsend/*` import resolved from the app.
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
}

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
const LOADER = `import { readFileSync, writeFileSync } from "node:fs";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
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
        result.simulations = [];
        for (const run of config.runs) {
          result.simulations.push(
            await testing.simulateJourney(
              byId.get(run.journeyId),
              {
                ...run.scenario,
                ...(templates ? { templates } : {}),
                ...(smsTemplates ? { smsTemplates } : {}),
              },
              { force: config.force },
            ),
          );
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
  simulations?: JourneySimulation[];
  error?: {
    code: string;
    message?: string;
    stack?: string;
    missing?: string[];
    available?: string[];
  };
}

function runChild(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ status: number | null; output: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const collect = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > 200_000) output = output.slice(-100_000);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", reject);
    child.on("close", (status) => resolvePromise({ status, output }));
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

/** Simulate every run in one child process and return the reports in order. */
export async function runSimulations(
  options: SimulateRunnerOptions,
): Promise<JourneySimulation[]> {
  const testingEntry = resolveTestingEntry(options.appRoot);
  const tsx = resolveTsxBin(options.appRoot);
  const registry = (relative: string): string | undefined => {
    if (!options.templates) return undefined;
    const path = join(options.appRoot, relative);
    return existsSync(path) ? pathToFileURL(path).href : undefined;
  };

  const dir = mkdtempSync(join(tmpdir(), "hogsend-simulate-"));
  const loaderFile = join(dir, "simulate.mjs");
  const configFile = join(dir, "config.json");
  const outFile = join(dir, "result.json");
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
    // engine entry and validate its env. Placeholders satisfy that; nothing is
    // dialled, and the app's .env is never read.
    const env = placeholderEnv({
      ...process.env,
      LOG_LEVEL: process.env.LOG_LEVEL ?? "error",
    });
    const child = await runChild(tsx, [loaderFile, configFile], {
      cwd: options.appRoot,
      env,
    });
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
    return result.simulations ?? [];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
