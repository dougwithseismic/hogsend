import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { JourneySimulation } from "@hogsend/testing";
import {
  buildRuns,
  listScenarioFiles,
  parseSimulateArgs,
  readScenarioFile,
  type ScenarioFile,
} from "../lib/simulate-args.js";
import { formatMarkdown, formatText } from "../lib/simulate-format.js";
import { runSimulations } from "../lib/simulate-runner.js";
import type { Command, CommandContext } from "./types.js";

const usage = `hogsend simulate <journeyId> [options]

Run one journey from your app on a virtual clock and print what it would do:
enrollment, every wait and how it resumed, checkpoints, sends, cross-journey
triggers, guard skips and the final status. Runs locally through
@hogsend/testing (install it in the app: pnpm add -D @hogsend/testing). No
database, Redis, Hatchet or .env is used, and nothing is sent.

Inputs:
  --user <json>             The enrolled user, e.g. '{"id":"u1","email":"a@b.co","properties":{"plan":"pro"}}'.
  --user-id <id>            Shorthand for the user id (default sim-user).
  --email <address>         Shorthand for the user email (default sim-user@example.com).
  --event <spec>            Script an event, repeatable: "<after>:<event>[:<json props>]".
                            <after> is offset from enrollment: 30m, 6h, 2d, 1w, 1d12h.
  --now <iso>               Virtual start time (default: now).
  --scenario <file.json>    Load a scenario file (user, events, guard changes,
                            preferences, history). Flags above layer on top.
  --all-scenarios <dir>     Run every *.json scenario in a directory.

Options:
  --format <text|markdown|json>  Output format (default text). markdown renders a
                            table for PR comments; json is a stable shape for tools.
  --force                   Simulate even if the enrollment guards would skip the user.
  --no-templates            Do not load src/emails/registry.ts / src/sms/registry.ts.
  --journeys <file>         Journeys module (default src/journeys/index.ts).
  --cwd <dir>               App root (defaults to the current directory).
  -h, --help                Show this help.

Exits 1 when a simulated journey throws; the error is shown in the timeline.

Examples:
  hogsend simulate activation-welcome
  hogsend simulate trial-upgrade --event "2d:project.created" --event "5d:subscription.created:{\\"plan\\":\\"pro\\"}"
  hogsend simulate trial-upgrade --scenario scenarios/converts.json --format markdown
  hogsend simulate --all-scenarios scenarios --format json`;

async function run(ctx: CommandContext): Promise<void> {
  let args: ReturnType<typeof parseSimulateArgs>;
  try {
    args = parseSimulateArgs(ctx.argv);
  } catch (error) {
    ctx.out.fail(error instanceof Error ? error.message : String(error));
  }
  if (args.help) {
    ctx.out.log(usage);
    return;
  }

  const appRoot = args.cwd ? resolve(args.cwd) : process.cwd();
  const journeysRel = args.journeys ?? join("src", "journeys", "index.ts");
  const journeysPath = isAbsolute(journeysRel)
    ? journeysRel
    : resolve(appRoot, journeysRel);
  if (!existsSync(journeysPath)) {
    ctx.out.fail(
      `journeys module not found: ${journeysPath} (run inside your app, or pass --cwd / --journeys)`,
    );
  }

  let runs: ReturnType<typeof buildRuns>;
  try {
    const paths = args.allScenarios
      ? listScenarioFiles(resolve(args.allScenarios))
      : args.scenario
        ? [resolve(args.scenario)]
        : [];
    const files: Array<{ path: string; file: ScenarioFile }> = paths.map(
      (path) => ({ path, file: readScenarioFile(path) }),
    );
    runs = buildRuns(args, files);
  } catch (error) {
    ctx.out.fail(error instanceof Error ? error.message : String(error));
  }

  const json = ctx.json || args.format === "json";
  const simulate = () =>
    runSimulations({
      appRoot,
      journeysPath,
      templates: args.templates,
      force: args.force,
      runs,
    });
  let reports: JourneySimulation[];
  try {
    // Only the text format gets a spinner: markdown and json are often piped.
    reports =
      !json && args.format === "text" && ctx.out.interactive
        ? await ctx.out.step(
            `Simulating ${runs.length === 1 ? runs[0]?.journeyId : `${runs.length} scenarios`}`,
            simulate,
          )
        : await simulate();
  } catch (error) {
    ctx.out.fail(error instanceof Error ? error.message : String(error));
  }

  if (json) {
    ctx.out.json({ simulations: reports });
  } else if (args.format === "markdown") {
    ctx.out.log(formatMarkdown(reports));
  } else {
    ctx.out.log(formatText(reports, { color: ctx.out.interactive }));
  }

  if (reports.some((report) => report.status === "failed")) {
    process.exitCode = 1;
  }
}

export const simulateCommand: Command = {
  name: "simulate",
  summary: "Run a journey on a virtual clock and print its timeline.",
  usage,
  run,
};
