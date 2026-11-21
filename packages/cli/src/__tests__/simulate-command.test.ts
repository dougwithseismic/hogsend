import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * End-to-end: run the real `hogsend simulate` entry point (src/bin.ts under
 * `node --import tsx`) against the fixture app in test/fixtures/simulate-app.
 * The fixture has no node_modules of its own; `@hogsend/testing`,
 * `@hogsend/engine` and `tsx` resolve from this package.
 */

const pkgRoot = resolve(import.meta.dirname, "..", "..");
const fixture = join(pkgRoot, "test", "fixtures", "simulate-app");
const tsxLoader = pathToFileURL(
  createRequire(import.meta.url).resolve("tsx"),
).href;
const bin = join(pkgRoot, "src", "bin.ts");

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function start(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): { child: ChildProcess; done: Promise<RunResult> } {
  const child = spawn(process.execPath, ["--import", tsxLoader, bin, ...args], {
    cwd: options.cwd ?? fixture,
    env: { ...process.env, NO_COLOR: "1", ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const done = new Promise<RunResult>((resolvePromise, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code, signal) =>
      resolvePromise({ code, signal, stdout, stderr }),
    );
  });
  return { child, done };
}

const hogsend = (
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> => start(args, options).done;

/** The simulate temp dirs currently in the OS temp directory. */
const simulateTempDirs = (): string[] =>
  readdirSync(tmpdir()).filter((name) => name.startsWith("hogsend-simulate-"));

const TIMEOUT = 90_000;

describe("hogsend simulate (e2e)", () => {
  it(
    "prints a markdown timeline for a scenario file",
    async () => {
      const result = await hogsend([
        "simulate",
        "trial-upgrade",
        "--scenario",
        "scenarios/converts.json",
        "--format",
        "markdown",
      ]);
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe(
        [
          "### `trial-upgrade` · converts on day 7",
          "",
          "**2 emails over 7 days; exits on `subscription.created`.**",
          "",
          "User `u_123` (ada@example.com) · starts 2026-03-02 09:00 UTC",
          "",
          "| Time | Step | Detail |",
          "| --- | --- | --- |",
          "| +0m | Enrolled | on `trial.started` |",
          '| +0m | Email | `trial-welcome` → ada@example.com · "Your trial has started" |',
          "| +0m | Wait for event | `await-project`: `project.created` up to 2d → event arrived at +1d |",
          "| +1d | Event | `project.created` |",
          "| +1d | Sleep | `trial-ending` for 5d → resumed at +6d |",
          '| +6d | Email | `trial-ending` → ada@example.com · "Two days left" · label `ending-reminder` |',
          "| +6d | Sleep | `trial-over` for 2d → interrupted by exit at +7d |",
          '| +7d | Event | `subscription.created` `{"plan":"pro"}` |',
          "| +7d | Exited | `subscription.created` (exitOn) |",
        ].join("\n"),
      );
    },
    TIMEOUT,
  );

  it(
    "runs every scenario in a directory and layers --event flags",
    async () => {
      const result = await hogsend([
        "simulate",
        "--all-scenarios",
        "scenarios",
        "--event",
        "8d:feature.used",
        "--format",
        "json",
      ]);
      expect(result.code).toBe(0);
      const { simulations } = JSON.parse(result.stdout) as {
        simulations: Array<{
          scenario: string;
          status: string;
          summary: { sent: { email: number }; triggers: number };
          notReached: Array<{ event: string }>;
          steps: Array<{ kind: string; wait?: string; outcome?: string }>;
        }>;
      };
      expect(simulations.map((s) => [s.scenario, s.status])).toEqual([
        ["converts on day 7", "exited"],
        ["never creates a project", "completed"],
      ]);
      expect(simulations[0]?.notReached).toEqual([
        expect.objectContaining({ event: "feature.used" }),
      ]);
      const lapsed = simulations[1];
      expect(lapsed?.summary.sent.email).toBe(3);
      expect(lapsed?.summary.triggers).toBe(1);
      expect(lapsed?.steps).toContainEqual(
        expect.objectContaining({ wait: "waitForEvent", outcome: "timedOut" }),
      );
    },
    TIMEOUT,
  );

  it(
    "exits 1 and shows the error when the journey throws",
    async () => {
      const result = await hogsend([
        "simulate",
        "broken-welcome",
        "--now",
        "2026-03-02T09:00:00Z",
        "--format",
        "markdown",
      ]);
      expect(result.code).toBe(1);
      expect(result.stdout).toContain(
        "**No messages over 1 hour; fails: template props missing: firstName**",
      );
      expect(result.stdout).toContain(
        "| +1h | Failed | template props missing: firstName |",
      );
    },
    TIMEOUT,
  );

  it(
    "lists the available journeys for an unknown id",
    async () => {
      const result = await hogsend(["simulate", "nope"]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        'unknown journey "nope". Available: broken-welcome, env-probe, spin, trial-upgrade, weekly-loop',
      );
    },
    TIMEOUT,
  );

  it(
    "stops a journey that never finishes at the horizon and exits 0",
    async () => {
      const result = await hogsend([
        "simulate",
        "weekly-loop",
        "--now",
        "2026-03-02T09:00:00Z",
        "--format",
        "markdown",
      ]);
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(
        "**4 emails over 30 days; still running at the horizon.**",
      );
      expect(result.stdout).toContain(
        "| +28d | Sleep | `week-5` for 7d → still waiting at +30d (horizon) |",
      );
      expect(result.stdout).toContain(
        "| +30d | Still running | stopped at the simulation horizon (+30d); extend it with `--until` |",
      );

      const custom = await hogsend([
        "simulate",
        "weekly-loop",
        "--now",
        "2026-03-02T09:00:00Z",
        "--until",
        "90d",
        "--format",
        "json",
      ]);
      expect(custom.code).toBe(0);
      const [report] = (
        JSON.parse(custom.stdout) as {
          simulations: Array<{
            status: string;
            horizon: { at: string };
            summary: { sent: { email: number } };
          }>;
        }
      ).simulations;
      expect(report?.status).toBe("running");
      expect(report?.horizon.at).toBe("2026-05-31T09:00:00.000Z");
      expect(report?.summary.sent.email).toBe(12);
    },
    TIMEOUT,
  );

  it(
    "keeps provider credentials and real connection strings out of the child",
    async () => {
      const result = await hogsend(
        ["simulate", "env-probe", "--format", "json"],
        {
          env: {
            POSTHOG_API_KEY: "phc_realLookingProjectKey0123456789abcdef",
            RESEND_API_KEY: "re_realLookingKey_0123456789",
            TWILIO_AUTH_TOKEN: "0123456789abcdef0123456789abcdef",
            DATABASE_URL: "postgresql://app:secret@db.example.com:5432/prod",
          },
        },
      );
      expect(result.code).toBe(0);
      const [report] = (
        JSON.parse(result.stdout) as {
          simulations: Array<{ steps: Array<{ subject?: string }> }>;
        }
      ).simulations;
      const subject = report?.steps.find((step) => step.subject)?.subject;
      expect(subject).toBe(
        "posthog=unset resend=unset twilio=unset db=placeholder.invalid",
      );
      expect(result.stdout).not.toContain("phc_realLookingProjectKey");
    },
    TIMEOUT,
  );

  it(
    "stops a run that exceeds the wall-clock limit and cleans up",
    async () => {
      const before = simulateTempDirs();
      const started = Date.now();
      const result = await hogsend(["simulate", "spin", "--timeout", "3"]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        "the simulation did not finish within 3s (wall clock) and was stopped",
      );
      expect(Date.now() - started).toBeLessThan(30_000);
      const leftover = simulateTempDirs().filter(
        (name) => !before.includes(name),
      );
      expect(leftover).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    "forwards SIGINT to the simulation and removes the temp dir",
    async () => {
      const before = simulateTempDirs();
      const { child, done } = start(["simulate", "spin", "--timeout", "60"]);
      // Wait until the runner has written its config, so the child is up.
      const deadline = Date.now() + 30_000;
      let dir: string | undefined;
      while (!dir && Date.now() < deadline) {
        dir = simulateTempDirs().find(
          (name) =>
            !before.includes(name) &&
            existsSync(join(tmpdir(), name, "config.json")),
        );
        if (!dir) await new Promise((r) => setTimeout(r, 100));
      }
      expect(dir).toBeDefined();
      await new Promise((r) => setTimeout(r, 500));
      const signalled = Date.now();
      child.kill("SIGINT");
      const result = await done;
      expect(result.code).toBe(130);
      expect(Date.now() - signalled).toBeLessThan(10_000);
      expect(existsSync(join(tmpdir(), dir as string))).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "reports a scenario that cannot run without hiding the others",
    async () => {
      const result = await hogsend([
        "simulate",
        "--all-scenarios",
        "scenarios-mixed",
        "--format",
        "json",
      ]);
      expect(result.code).toBe(1);
      const output = JSON.parse(result.stdout) as {
        simulations: Array<{ scenario: string; status: string }>;
        errors: Array<{ source: string; journeyId: string; message: string }>;
      };
      expect(output.simulations.map((s) => [s.scenario, s.status])).toEqual([
        ["never creates a project", "completed"],
        ["converts on day 7", "exited"],
      ]);
      expect(output.errors).toEqual([
        {
          source: join(fixture, "scenarios-mixed", "b-broken.json"),
          journeyId: "trial-upgrade",
          message: expect.stringContaining("null"),
        },
      ]);

      const text = await hogsend([
        "simulate",
        "--all-scenarios",
        "scenarios-mixed",
      ]);
      expect(text.code).toBe(1);
      expect(text.stdout).toContain("never creates a project");
      expect(text.stdout).toContain("converts on day 7");
      expect(text.stderr).toContain(
        `error ${join(fixture, "scenarios-mixed", "b-broken.json")} (trial-upgrade):`,
      );
    },
    TIMEOUT,
  );

  it(
    "resolves passed paths against the shell's cwd, not --cwd",
    async () => {
      const result = await hogsend(
        [
          "simulate",
          "--cwd",
          "test/fixtures/simulate-app",
          "--scenario",
          "test/fixtures/simulate-app/scenarios/converts.json",
          "--format",
          "json",
        ],
        { cwd: pkgRoot },
      );
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      const { simulations } = JSON.parse(result.stdout) as {
        simulations: Array<{ scenario: string }>;
      };
      expect(simulations[0]?.scenario).toBe("converts on day 7");
    },
    TIMEOUT,
  );
});
