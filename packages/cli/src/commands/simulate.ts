import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  buildRuns,
  DEFAULT_TIMEOUT_SECONDS,
  listScenarioFiles,
  parseSimulateArgs,
  readScenarioFile,
  type ScenarioFile,
} from "../lib/simulate-args.js";
import { formatMarkdown, formatText } from "../lib/simulate-format.js";
import {
  runSimulations,
  type SimulationResults,
} from "../lib/simulate-runner.js";
import type { Command, CommandContext } from "./types.js";

const usage = `hogsend simulate <journeyId> [options]

Run one journey from your app on a virtual clock and print what it would do:
enrollment, every wait and how it resumed, checkpoints, sends, cross-journey
triggers, guard skips and the final status. Runs locally through
@hogsend/testing (install it in the app: pnpm add -D @hogsend/testing). No
database, Redis, Hatchet or .env is used, and nothing is sent: the journeys
run in a child process with a clean environment, so provider keys in your
shell (PostHog, Resend, Twilio, ...) never reach them.

Inputs:
  --user <json>             The enrolled user, e.g. '{"id":"u1","email":"a@b.co","properties":{"plan":"pro"}}'.
  --user-id <id>            Shorthand for the user id (default sim-user).
  --email <address>         Shorthand for the user email (default sim-user@example.com).
  --event <spec>            Script an event, repeatable: "<after>:<event>[:<json props>]".
                            <after> is offset from enrollment: 30m, 6h, 2d, 1w, 1d12h.
  --now <iso>               Virtual start time, an ISO 8601 date or date-time
                            (no offset means UTC). Default: the scenario's "now",
                            else the current time. Pass it for repeatable output.
  --until <duration>        Stop after this much virtual time (default 720h, the
                            engine's journey limit). A journey still waiting then
                            is reported as running, not failed.
  --scenario <file.json>    Load a scenario file (user, events, guard changes,
                            preferences, history). Flags above layer on top.
  --all-scenarios <dir>     Run every *.json scenario in a directory.

Options:
  --format <text|markdown|json>  Output format (default text). markdown renders a
                            table for PR comments; json is a stable shape for tools.
  --force                   Simulate even if the enrollment guards would skip the user.
  --no-templates            Do not load src/emails/registry.ts / src/sms/registry.ts.
  --journeys <file>         Journeys module (default <app>/src/journeys/index.ts).
  --cwd <dir>               App root (defaults to the current directory).
  --timeout <seconds>       Wall-clock limit for the whole run (default ${DEFAULT_TIMEOUT_SECONDS}).
  -h, --help                Show this help.

Paths you pass (--scenario, --all-scenarios, --journeys, --cwd) are relative to
the current directory; only the defaults are relative to the app root.

Exits 1 when a simulated journey throws (the error is shown in the timeline),
when a scenario cannot be run, when a run exceeds 10,000 steps, or when the
wall-clock limit stops it.

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

  // Paths the user passes resolve against the shell's cwd; only the default
  // journeys entry is relative to the app root.
  const appRoot = args.cwd ? resolve(args.cwd) : process.cwd();
  const journeysPath = args.journeys
    ? resolve(args.journeys)
    : join(appRoot, "src", "journeys", "index.ts");
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
      timeoutMs: args.timeoutMs,
    });
  let results: SimulationResults;
  try {
    // Only the text format gets a spinner: markdown and json are often piped.
    results =
      !json && args.format === "text" && ctx.out.interactive
        ? await ctx.out.step(
            `Simulating ${runs.length === 1 ? runs[0]?.journeyId : `${runs.length} scenarios`}`,
            simulate,
          )
        : await simulate();
  } catch (error) {
    ctx.out.fail(error instanceof Error ? error.message : String(error));
  }

  const { simulations: reports, errors } = results;
  if (json) {
    ctx.out.json({
      simulations: reports,
      ...(errors.length > 0 ? { errors } : {}),
    });
  } else {
    if (reports.length > 0) {
      ctx.out.log(
        args.format === "markdown"
          ? formatMarkdown(reports)
          : formatText(reports, { color: ctx.out.interactive }),
      );
    }
    for (const error of errors) {
      process.stderr.write(
        `error ${error.source} (${error.journeyId}): ${error.message}\n`,
      );
    }
  }

  if (
    errors.length > 0 ||
    reports.some((report) => report.status === "failed")
  ) {
    process.exitCode = 1;
  }
}

export const simulateCommand: Command = {
  name: "simulate",
  summary: "Run a journey on a virtual clock and print its timeline.",
  usage,
  run,
};
