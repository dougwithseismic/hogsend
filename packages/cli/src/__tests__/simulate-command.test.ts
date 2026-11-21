import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * End-to-end: run the real `hogsend simulate` entry point (src/bin.ts under
 * tsx) against the fixture app in test/fixtures/simulate-app. The fixture has
 * no node_modules of its own; `@hogsend/testing`, `@hogsend/engine` and `tsx`
 * resolve from this package.
 */

const pkgRoot = resolve(import.meta.dirname, "..", "..");
const fixture = join(pkgRoot, "test", "fixtures", "simulate-app");
const tsx = join(pkgRoot, "node_modules", ".bin", "tsx");
const bin = join(pkgRoot, "src", "bin.ts");

function hogsend(
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(tsx, [bin, ...args], {
      cwd: fixture,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

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
        'unknown journey "nope". Available: broken-welcome, trial-upgrade',
      );
    },
    TIMEOUT,
  );
});
