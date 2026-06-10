import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  type ManagedProcess,
  shutdownAll,
  spawnManaged,
  waitForHttp,
} from "../lib/proc.js";

const node = process.execPath;
const identity = (s: string) => s;

/** Spawn a managed node -e child, capturing prefixed lines via the sink. */
function spawnFixture(opts: {
  name: string;
  script: string;
  prefixColor?: (s: string) => string;
  env?: Record<string, string>;
}): { proc: ManagedProcess; lines: string[] } {
  const lines: string[] = [];
  const proc = spawnManaged({
    name: opts.name,
    cmd: node,
    args: ["-e", opts.script],
    cwd: process.cwd(),
    env: opts.env,
    prefixColor: opts.prefixColor ?? identity,
    sink: (s) => lines.push(s),
  });
  return { proc, lines };
}

/** Wait until a predicate over captured lines holds (or time out). */
async function waitForLines(
  lines: string[],
  predicate: (joined: string) => boolean,
  timeoutMs = 4000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate(lines.join(""))) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for lines; got: ${lines.join("")}`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("spawnManaged", () => {
  it("prefixes every stdout and stderr line with the colored [name] tag", async () => {
    const { proc, lines } = spawnFixture({
      name: "fix",
      script: "console.log('a\\nb'); console.error('c');",
      prefixColor: (s) => `<${s}>`,
    });
    await proc.exited;
    await waitForLines(lines, (all) => all.includes("c"));
    expect(lines).toContain("<[fix]> a\n");
    expect(lines).toContain("<[fix]> b\n");
    expect(lines).toContain("<[fix]> c\n");
  });

  it("merges opts.env over the parent env", async () => {
    const { proc, lines } = spawnFixture({
      name: "env",
      script: "console.log(process.env.HOGSEND_PROC_TEST);",
      env: { HOGSEND_PROC_TEST: "hello-env" },
    });
    await proc.exited;
    await waitForLines(lines, (all) => all.includes("hello-env"));
    expect(lines.join("")).toContain("[env] hello-env");
  });

  it("resolves exited and fires onExit with the exit code", async () => {
    const { proc } = spawnFixture({ name: "exit", script: "process.exit(3)" });
    const fromCallback = new Promise<number | null>((resolve) => {
      proc.onExit((info) => resolve(info.code));
    });
    const info = await proc.exited;
    expect(info.code).toBe(3);
    await expect(fromCallback).resolves.toBe(3);
  });

  it("fires onExit even when registered after the child exited", async () => {
    const { proc } = spawnFixture({ name: "late", script: "" });
    await proc.exited;
    const code = await new Promise<number | null>((resolve) => {
      proc.onExit((info) => resolve(info.code));
    });
    expect(code).toBe(0);
  });
});

describe("shutdownAll", () => {
  it("SIGTERMs a well-behaved child and resolves promptly", async () => {
    const { proc } = spawnFixture({
      name: "loop",
      script: "setInterval(() => {}, 1000); console.log('ready');",
    });
    const pid = proc.child.pid;
    expect(pid).toBeDefined();

    const started = Date.now();
    await shutdownAll([proc]);
    expect(Date.now() - started).toBeLessThan(4000);
    expect(isAlive(pid as number)).toBe(false);
  });

  it("SIGKILLs a child that traps SIGTERM after timeoutMs", async () => {
    const { proc, lines } = spawnFixture({
      name: "stubborn",
      script:
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); console.log('ready');",
    });
    // Ensure the SIGTERM handler is installed before we try to kill.
    await waitForLines(lines, (all) => all.includes("ready"));
    const pid = proc.child.pid as number;

    await shutdownAll([proc], { timeoutMs: 300 });
    expect(isAlive(pid)).toBe(false);
  });

  it("is idempotent and tolerates already-exited children", async () => {
    const { proc } = spawnFixture({ name: "gone", script: "" });
    await proc.exited;
    await expect(shutdownAll([proc])).resolves.toBeUndefined();
    await expect(shutdownAll([proc])).resolves.toBeUndefined();
  });

  it("resolves on an empty list", async () => {
    await expect(shutdownAll([])).resolves.toBeUndefined();
  });
});

describe("waitForHttp", () => {
  it("resolves once the endpoint returns 2xx, polling through 503s", async () => {
    let hits = 0;
    const server = createServer((_req, res) => {
      hits += 1;
      if (hits < 3) {
        res.writeHead(503);
        res.end("not yet");
        return;
      }
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise<void>((r) => server.listen(0, () => r()));
    const port = (server.address() as AddressInfo).port;

    try {
      await waitForHttp(`http://127.0.0.1:${port}/health`, 10_000);
      expect(hits).toBeGreaterThanOrEqual(3);
    } finally {
      server.close();
    }
  });

  it("rejects with the URL and last error after the overall timeout", async () => {
    // Grab a port that is closed (listen then immediately close).
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, () => r()));
    const port = (server.address() as AddressInfo).port;
    await new Promise<void>((r) => server.close(() => r()));

    const url = `http://127.0.0.1:${port}/health`;
    await expect(waitForHttp(url, 1200)).rejects.toThrow(url);
  });
});
