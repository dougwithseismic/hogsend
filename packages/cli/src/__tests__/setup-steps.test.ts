import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  detectRunningInfra,
  dockerComposeUp,
  ensureAuthSecret,
  ensureEnvFile,
  hasComposeFile,
  probeTcp,
  readDotEnv,
  runMigrations,
} from "../lib/setup-steps.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn() };
});

const mockSpawnSync = vi.mocked(spawnSync);

type SpawnSyncResult = ReturnType<typeof spawnSync>;

function spawnResult(partial: Partial<SpawnSyncResult>): SpawnSyncResult {
  return {
    pid: 1,
    output: [],
    stdout: "",
    stderr: "",
    status: 0,
    signal: null,
    ...partial,
  } as SpawnSyncResult;
}

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "hogsend-setup-steps-"));
  mockSpawnSync.mockReset();
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("ensureEnvFile", () => {
  it("copies .env.example to .env when .env is missing", () => {
    writeFileSync(join(cwd, ".env.example"), "FOO=bar\n");
    const res = ensureEnvFile(cwd);
    expect(res).toEqual({
      step: "env",
      status: "ok",
      detail: "copied .env.example -> .env",
    });
    expect(readFileSync(join(cwd, ".env"), "utf8")).toBe("FOO=bar\n");
  });

  it("skips when .env already exists", () => {
    writeFileSync(join(cwd, ".env"), "FOO=existing\n");
    const res = ensureEnvFile(cwd);
    expect(res).toEqual({
      step: "env",
      status: "skipped",
      detail: ".env already exists",
    });
    expect(readFileSync(join(cwd, ".env"), "utf8")).toBe("FOO=existing\n");
  });

  it("fails when neither .env nor .env.example exists", () => {
    const res = ensureEnvFile(cwd);
    expect(res).toEqual({
      step: "env",
      status: "failed",
      detail: "no .env and no .env.example to copy from",
    });
  });
});

describe("ensureAuthSecret", () => {
  it("replaces the change-me placeholder with a 64-char hex secret", () => {
    writeFileSync(
      join(cwd, ".env"),
      "PORT=3002\nBETTER_AUTH_SECRET=change-me-please\n",
    );
    const res = ensureAuthSecret(cwd);
    expect(res).toEqual({
      step: "secret",
      status: "ok",
      detail: "generated BETTER_AUTH_SECRET (64-char hex)",
    });
    const raw = readFileSync(join(cwd, ".env"), "utf8");
    const match = raw.match(/^BETTER_AUTH_SECRET=([0-9a-f]{64})$/m);
    expect(match).not.toBeNull();
    expect(raw).toContain("PORT=3002");
  });

  it("replaces a REPLACE_ME placeholder (the dogfood .env.example style)", () => {
    // apps/api/.env.example ships BETTER_AUTH_SECRET=REPLACE_ME_RUN_pnpm_gen:secret —
    // it must be treated as a placeholder, not preserved as an invalid secret.
    writeFileSync(
      join(cwd, ".env"),
      "BETTER_AUTH_SECRET=REPLACE_ME_RUN_pnpm_gen:secret\n",
    );
    const res = ensureAuthSecret(cwd);
    expect(res).toEqual({
      step: "secret",
      status: "ok",
      detail: "generated BETTER_AUTH_SECRET (64-char hex)",
    });
    const raw = readFileSync(join(cwd, ".env"), "utf8");
    expect(raw).toMatch(/^BETTER_AUTH_SECRET=[0-9a-f]{64}$/m);
    expect(raw).not.toContain("REPLACE_ME");
  });

  it("appends the key when it is missing entirely", () => {
    writeFileSync(join(cwd, ".env"), "PORT=3002");
    const res = ensureAuthSecret(cwd);
    expect(res.status).toBe("ok");
    const raw = readFileSync(join(cwd, ".env"), "utf8");
    expect(raw).toMatch(/BETTER_AUTH_SECRET=[0-9a-f]{64}/);
  });

  it("never overwrites a real secret", () => {
    const real = "a".repeat(64);
    writeFileSync(join(cwd, ".env"), `BETTER_AUTH_SECRET=${real}\n`);
    const res = ensureAuthSecret(cwd);
    expect(res).toEqual({
      step: "secret",
      status: "skipped",
      detail: "BETTER_AUTH_SECRET already set",
    });
    expect(readFileSync(join(cwd, ".env"), "utf8")).toContain(real);
  });

  it("skips when no .env exists", () => {
    const res = ensureAuthSecret(cwd);
    expect(res).toEqual({
      step: "secret",
      status: "skipped",
      detail: "skipped — no .env",
    });
  });
});

describe("hasComposeFile", () => {
  it("is false in an empty dir", () => {
    expect(hasComposeFile(cwd)).toBe(false);
  });

  it.each([
    "docker-compose.yml",
    "docker-compose.yaml",
    "compose.yml",
    "compose.yaml",
  ])("detects %s", (name) => {
    writeFileSync(join(cwd, name), "services: {}\n");
    expect(hasComposeFile(cwd)).toBe(true);
  });
});

describe("readDotEnv", () => {
  it("parses KEY=value, export-prefixed lines, quotes and comments", () => {
    writeFileSync(
      join(cwd, ".env"),
      [
        "# comment",
        "PORT=3002",
        "export REDIS_PORT=6380",
        'QUOTED="hello world"',
        "",
        "NOEQ",
      ].join("\n"),
    );
    expect(readDotEnv(cwd)).toEqual({
      PORT: "3002",
      REDIS_PORT: "6380",
      QUOTED: "hello world",
    });
  });

  it("returns an empty record when no .env exists", () => {
    expect(readDotEnv(cwd)).toEqual({});
  });
});

describe("dockerComposeUp", () => {
  it("returns ok on exit 0", async () => {
    mockSpawnSync.mockReturnValue(spawnResult({ status: 0 }));
    const res = await dockerComposeUp(cwd, { quiet: true });
    expect(res).toEqual({
      step: "docker",
      status: "ok",
      detail: "Postgres + Redis + Hatchet-Lite up",
    });
    expect(mockSpawnSync).toHaveBeenCalledWith(
      "docker",
      ["compose", "up", "-d"],
      expect.objectContaining({ cwd, stdio: "ignore" }),
    );
  });

  it("returns failed with the exit code in detail", async () => {
    mockSpawnSync.mockReturnValue(spawnResult({ status: 1 }));
    const res = await dockerComposeUp(cwd);
    expect(res).toEqual({
      step: "docker",
      status: "failed",
      detail: "docker compose exited with code 1",
    });
  });

  it("returns failed with ? when the docker CLI is missing", async () => {
    mockSpawnSync.mockReturnValue(
      spawnResult({ status: null, error: new Error("spawn docker ENOENT") }),
    );
    const res = await dockerComposeUp(cwd);
    expect(res.status).toBe("failed");
    expect(res.detail).toBe("docker compose exited with code ?");
  });
});

describe("runMigrations", () => {
  it("returns ok on exit 0", async () => {
    mockSpawnSync.mockReturnValue(spawnResult({ status: 0 }));
    const res = await runMigrations(cwd, { quiet: true });
    expect(res).toEqual({
      step: "migrate",
      status: "ok",
      detail: "engine + client migrations applied",
    });
    expect(mockSpawnSync).toHaveBeenCalledWith(
      "pnpm",
      ["db:migrate"],
      expect.objectContaining({ cwd, stdio: "ignore" }),
    );
  });

  it("returns failed with the exit code in detail", async () => {
    mockSpawnSync.mockReturnValue(spawnResult({ status: 7 }));
    const res = await runMigrations(cwd);
    expect(res).toEqual({
      step: "migrate",
      status: "failed",
      detail: "pnpm db:migrate exited with code 7",
    });
  });
});

describe("probeTcp", () => {
  let server: Server;
  let openPort: number;

  beforeEach(async () => {
    server = createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    openPort = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("resolves true for a listening port", async () => {
    await expect(probeTcp({ port: openPort })).resolves.toBe(true);
  });

  it("resolves false for a closed port", async () => {
    const closer = createServer();
    await new Promise<void>((r) => closer.listen(0, "127.0.0.1", () => r()));
    const closedPort = (closer.address() as { port: number }).port;
    await new Promise<void>((r) => closer.close(() => r()));
    await expect(probeTcp({ port: closedPort })).resolves.toBe(false);
  });
});

describe("detectRunningInfra", () => {
  /** Point all three .env ports at a known-closed port so probes are false. */
  async function closedPort(): Promise<number> {
    const s = createServer();
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
    const port = (s.address() as { port: number }).port;
    await new Promise<void>((r) => s.close(() => r()));
    return port;
  }

  it("maps compose ps line-json output to the three services", async () => {
    mockSpawnSync.mockReturnValue(
      spawnResult({
        status: 0,
        stdout: [
          '{"Service":"postgres","State":"running"}',
          '{"Service":"redis","State":"running"}',
          '{"Service":"hatchet-lite","State":"running"}',
          '{"Service":"hatchet-postgres","State":"running"}',
        ].join("\n"),
      }),
    );
    const res = await detectRunningInfra(cwd);
    expect(res).toEqual({ postgres: true, redis: true, hatchet: true });
  });

  it("treats non-running compose states as down (probe fallback false)", async () => {
    const dead = await closedPort();
    writeFileSync(
      join(cwd, ".env"),
      `POSTGRES_PORT=${dead}\nREDIS_PORT=${dead}\nHATCHET_DASHBOARD_PORT=${dead}\n`,
    );
    mockSpawnSync.mockReturnValue(
      spawnResult({
        status: 0,
        stdout: [
          '{"Service":"postgres","State":"running"}',
          '{"Service":"redis","State":"exited"}',
          '{"Service":"hatchet-lite","State":"exited"}',
        ].join("\n"),
      }),
    );
    const res = await detectRunningInfra(cwd);
    expect(res).toEqual({ postgres: true, redis: false, hatchet: false });
  });

  it("falls back to .env port probes when the docker CLI is missing", async () => {
    const listener = createServer();
    await new Promise<void>((r) => listener.listen(0, "127.0.0.1", () => r()));
    const open = (listener.address() as { port: number }).port;
    const dead = await closedPort();

    writeFileSync(
      join(cwd, ".env"),
      `POSTGRES_PORT=${open}\nREDIS_PORT=${dead}\nHATCHET_DASHBOARD_PORT=${dead}\n`,
    );
    mockSpawnSync.mockReturnValue(
      spawnResult({ status: null, error: new Error("spawn docker ENOENT") }),
    );

    try {
      const res = await detectRunningInfra(cwd);
      expect(res).toEqual({ postgres: true, redis: false, hatchet: false });
    } finally {
      await new Promise<void>((r) => listener.close(() => r()));
    }
  });

  it("never throws, even on garbage compose output", async () => {
    const dead = await closedPort();
    writeFileSync(
      join(cwd, ".env"),
      `POSTGRES_PORT=${dead}\nREDIS_PORT=${dead}\nHATCHET_DASHBOARD_PORT=${dead}\n`,
    );
    mockSpawnSync.mockReturnValue(
      spawnResult({ status: 0, stdout: "not json at all\n{broken" }),
    );
    await expect(detectRunningInfra(cwd)).resolves.toEqual({
      postgres: false,
      redis: false,
      hatchet: false,
    });
  });
});
