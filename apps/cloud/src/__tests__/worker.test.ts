import { afterEach, describe, expect, it, vi } from "vitest";
import { startWorker, type WorkerLogLine } from "../worker-runtime";

/**
 * The worker is a long-lived process, so every test here drives it through
 * `startWorker()` with an injected clock/logger rather than spawning one — a
 * process test would be slow, flaky, and could not read the boot line.
 */

const TEST_URL = "postgres://growthhog:growthhog@localhost:5434/hogsend_cloud";

function collector() {
  const lines: WorkerLogLine[] = [];
  return { lines, log: (line: WorkerLogLine) => lines.push(line) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("startWorker", () => {
  it("logs a structured boot line naming the service, node version and env", () => {
    const { lines, log } = collector();
    const worker = startWorker({
      databaseUrl: TEST_URL,
      nodeEnv: "test",
      log,
    });

    expect(lines[0]).toMatchObject({
      service: "cloud-worker",
      event: "boot",
      env: "test",
      node: process.version,
    });
    // No secrets on the wire: the boot line must not carry the DSN.
    expect(JSON.stringify(lines[0])).not.toContain("growthhog");

    return worker.stop();
  });

  it("returns a handle whose stop() resolves cleanly and is idempotent", async () => {
    const { lines, log } = collector();
    const worker = startWorker({ databaseUrl: TEST_URL, nodeEnv: "test", log });

    await expect(worker.stop()).resolves.toBeUndefined();
    expect(lines.at(-1)).toMatchObject({
      service: "cloud-worker",
      event: "shutdown",
    });

    const linesAfterFirstStop = lines.length;
    await expect(worker.stop()).resolves.toBeUndefined();
    // A second stop is a no-op, not a second shutdown line or a throw.
    expect(lines).toHaveLength(linesAfterFirstStop);
  });

  it("heartbeats on its interval and stops heartbeating once stopped", async () => {
    vi.useFakeTimers();
    const { lines, log } = collector();
    const worker = startWorker({
      databaseUrl: TEST_URL,
      nodeEnv: "test",
      heartbeatMs: 1_000,
      log,
    });

    vi.advanceTimersByTime(3_000);
    const heartbeats = lines.filter((line) => line.event === "heartbeat");
    expect(heartbeats).toHaveLength(3);
    expect(heartbeats[0]).toMatchObject({ service: "cloud-worker" });
    expect(typeof heartbeats[0]?.uptimeMs).toBe("number");

    await worker.stop();
    vi.advanceTimersByTime(10_000);
    expect(lines.filter((line) => line.event === "heartbeat")).toHaveLength(3);
  });

  it("reports running state across the lifecycle", async () => {
    const worker = startWorker({
      databaseUrl: TEST_URL,
      nodeEnv: "test",
      log: () => {},
    });
    expect(worker.running).toBe(true);
    await worker.stop();
    expect(worker.running).toBe(false);
  });

  it("throws when CLOUD_DATABASE_URL is empty in production", () => {
    expect(() =>
      startWorker({ databaseUrl: "", nodeEnv: "production", log: () => {} }),
    ).toThrow(/CLOUD_DATABASE_URL/);
  });

  it("throws when CLOUD_DATABASE_URL is empty in any mode", () => {
    // The control plane has no useful work without its database, so an empty
    // DSN is a boot failure everywhere — production is merely the case that
    // has no dev fallback to hide it.
    expect(() =>
      startWorker({
        databaseUrl: "   ",
        nodeEnv: "development",
        log: () => {},
      }),
    ).toThrow(/CLOUD_DATABASE_URL/);
  });

  it("registers the provisioning task when Hatchet is configured", async () => {
    const { lines, log } = collector();
    let stopped = false;
    const worker = startWorker({
      databaseUrl: TEST_URL,
      nodeEnv: "test",
      log,
      hatchetConfigured: true,
      substrate: "fake",
      startHatchetWorker: async () => ({
        async start() {},
        async stop() {
          stopped = true;
        },
      }),
    });

    // The boot line counts `provision-stack`; zero would mean an idle worker.
    expect(lines[0]).toMatchObject({ event: "boot", tasks: 1 });

    await worker.stop();
    expect(stopped).toBe(true);
    expect(lines.some((line) => line.event === "tasks")).toBe(true);
  });

  it("reports zero tasks and never builds a worker without a Hatchet token", async () => {
    const { lines, log } = collector();
    let built = false;
    const worker = startWorker({
      databaseUrl: TEST_URL,
      nodeEnv: "test",
      log,
      hatchetConfigured: false,
      substrate: "fake",
      startHatchetWorker: async () => {
        built = true;
        return { async start() {}, async stop() {} };
      },
    });

    expect(lines[0]).toMatchObject({ event: "boot", tasks: 0 });
    expect(built).toBe(false);
    await worker.stop();
  });

  it("fails closed when a real substrate has no Hatchet token", () => {
    // The EARS: never silently fake, and never provision from a web request.
    expect(() =>
      startWorker({
        databaseUrl: TEST_URL,
        nodeEnv: "production",
        log: () => {},
        hatchetConfigured: false,
        substrate: "railway",
      }),
    ).toThrow(/CLOUD_HATCHET_CLIENT_TOKEN/);
  });

  it("does not register process signal handlers itself", () => {
    // Signal wiring belongs to the entry point (src/worker.ts); a library
    // function that grabs SIGTERM would fight its host.
    const before = process.listenerCount("SIGTERM");
    const worker = startWorker({
      databaseUrl: TEST_URL,
      nodeEnv: "test",
      log: () => {},
    });
    expect(process.listenerCount("SIGTERM")).toBe(before);
    return worker.stop();
  });
});
