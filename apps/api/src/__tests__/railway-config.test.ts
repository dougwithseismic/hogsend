import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Cheap structural guard for the STAGED two-track Railway configs
// (railway.toml.phase6 / railway.worker.toml.phase6). Phase 6 ships no
// production code; this just keeps the staged deploy strings honest so a stray
// edit can't quietly reorder the migration tracks or drop a track before the
// operator promotes them at cutover. See docs/phase-6-dogfood-runbook.md.

const REPO_ROOT = resolve(process.cwd(), "../..");

/**
 * Pull a single `key = "value"` string out of a flat TOML file. We avoid adding
 * a TOML parser dependency just for a guard test; the staged configs are simple
 * key/value pairs, so a line-scan is sufficient and dependency-free.
 */
function readTomlString(file: string, key: string): string | null {
  const text = readFileSync(resolve(REPO_ROOT, file), "utf8");
  const re = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m");
  const m = text.match(re);
  return m?.[1] ?? null;
}

describe("staged Phase 6 Railway config (railway.toml.phase6)", () => {
  it("runs the engine migrate track before the client migrate track", () => {
    const preDeploy = readTomlString("railway.toml.phase6", "preDeployCommand");
    expect(preDeploy).toBeTruthy();
    const cmd = preDeploy as string;

    // Both tracks present.
    expect(cmd).toMatch(/db:migrate\b/);
    expect(cmd).toMatch(/db:migrate:client\b/);
    // Chained with && so a failed engine migrate aborts before the client one.
    expect(cmd).toContain("&&");
    // Engine BEFORE client. db:migrate:client also contains "db:migrate", so
    // assert the standalone engine command precedes the client command.
    expect(cmd).toMatch(/db:migrate\b(?![:])[\s\S]*&&[\s\S]*db:migrate:client/);
  });

  it("installs deps before building (published-dep client repo)", () => {
    const build = readTomlString("railway.toml.phase6", "buildCommand");
    expect(build).toBeTruthy();
    const cmd = build as string;
    expect(cmd).toContain("pnpm install");
    expect(cmd).toMatch(/pnpm install[\s\S]*&&[\s\S]*build/);
  });

  it("keeps the API healthcheck on /v1/health", () => {
    const path = readTomlString("railway.toml.phase6", "healthcheckPath");
    expect(path).toBe("/v1/health");
  });
});

describe("staged Phase 6 worker config (railway.worker.toml.phase6)", () => {
  it("starts the worker and runs no migrations / healthcheck", () => {
    expect(readTomlString("railway.worker.toml.phase6", "startCommand")).toBe(
      "pnpm --filter @hogsend/api worker",
    );
    // A port-less worker must not declare a healthcheck or a preDeploy migrate.
    // Check only declared KEYS (ignore comment prose that mentions them) by
    // scanning non-comment lines for `key =`.
    const keys = readFileSync(
      resolve(REPO_ROOT, "railway.worker.toml.phase6"),
      "utf8",
    )
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .filter((line) => /^\s*[A-Za-z]+\s*=/.test(line))
      .map((line) => line.trim().split(/\s*=/)[0]);
    expect(keys).not.toContain("healthcheckPath");
    expect(keys).not.toContain("preDeployCommand");
  });
});
