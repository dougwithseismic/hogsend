import assert from "node:assert/strict";
import { type AddressInfo, createServer } from "node:net";
import { after, before, test } from "node:test";
import { recordBootDiagnostic } from "./boot-diagnostics.js";
import type { Logger } from "./logger.js";
import { getRedisIfConnected } from "./redis.js";
import {
  getWorkerHeartbeat,
  startWorkerHeartbeat,
} from "./worker-heartbeat.js";

// WHY this file exists: the boot-diagnostics collector is per-OS-process
// memory and only the API process serves HTTP — a worker-only
// misconfiguration (TWILIO_*, APOLLO_API_KEY live on the worker service)
// records into a collector no surface can read, which is exactly #611's
// shape. The heartbeat is the channel that already crosses that process
// boundary, so the WRITE leg below must carry the collector. The health and
// admin tests seed heartbeat payloads by hand; without this file, dropping
// diagnostics from the write would keep every other test green.

// worker-heartbeat.ts imports only redis + boot-diagnostics + a type-only
// Logger — no env.ts in the graph — so static imports are safe here. The
// ioredis singleton reads REDIS_URL when the first command forces creation,
// which happens inside the first test, after before() points it at the stub.

const WORKER_SENTINEL = {
  code: "test.worker-heartbeat-sentinel",
  message: "sentinel recorded in this (worker-role) process's collector",
};

// ---- Minimal RESP stub standing in for Redis -------------------------------
//
// Same trick as routes/health.config.test.ts, plus SET capture: the stub
// remembers the exact value argument the heartbeat wrote, so the test asserts
// what was PUBLISHED, not just that a write happened. DEL clears it, GET
// serves it back — giving a real write→read round trip over the wire.
let stored: string | null = null;

function bulk(s: string): string {
  return `$${Buffer.byteLength(s)}\r\n${s}\r\n`;
}

const redisStub = createServer((socket) => {
  socket.on("data", (buf) => {
    const raw = buf.toString();
    // Capture SET's value argument from the RESP tokens: after the "set"
    // token come "$<keylen>", the key, "$<valuelen>", then the value.
    const tokens = raw.split("\r\n");
    const setIdx = tokens.findIndex((t) => t.toLowerCase() === "set");
    if (setIdx !== -1) {
      stored = tokens[setIdx + 4] ?? null;
    }
    if (tokens.some((t) => t.toLowerCase() === "del")) {
      stored = null;
    }
    // Reply per inbound command array (see the health test for why splitting
    // on the array marker is sufficient on this wire). "set" is checked
    // before "get" because the SET payload is arbitrary JSON.
    const commands = raw.toLowerCase().split("*").slice(1);
    const replies = commands.map((cmd) => {
      if (cmd.includes("info")) return bulk("redis_version:7.4.0\r\n");
      if (cmd.includes("ping")) return "+PONG\r\n";
      if (cmd.includes("set")) return "+OK\r\n";
      if (cmd.includes("del")) return ":1\r\n";
      if (cmd.includes("get")) {
        return stored === null ? "$-1\r\n" : bulk(stored);
      }
      return "+OK\r\n";
    });
    socket.write(replies.join(""));
  });
});

before(async () => {
  await new Promise<void>((resolve) => {
    redisStub.listen(0, "127.0.0.1", resolve);
  });
  const { port } = redisStub.address() as AddressInfo;
  process.env.REDIS_URL = `redis://127.0.0.1:${port}`;
});

after(async () => {
  // The ioredis singleton would otherwise hold the event loop open.
  getRedisIfConnected()?.disconnect();
  await new Promise<void>((resolve) => {
    redisStub.close(() => resolve());
  });
});

const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
} as unknown as Logger;

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) {
      throw new Error("condition not met in time");
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("write leg: the heartbeat publishes the collector as a JSON payload", async () => {
  recordBootDiagnostic(WORKER_SENTINEL);

  const stop = startWorkerHeartbeat(silentLogger);
  await waitFor(() => stored !== null);

  // The published payload must be JSON carrying BOTH the liveness timestamp
  // and this process's diagnostics — codes and messages, so the admin route
  // can show worker detail, not just a count.
  const payload = JSON.parse(stored as string);
  assert.equal(typeof payload.lastSeenAt, "string");
  assert.deepEqual(
    payload.diagnostics.find(
      (d: { code: string }) => d.code === WORKER_SENTINEL.code,
    ),
    WORKER_SENTINEL,
  );

  // Round trip: the read leg parses what the write leg published.
  const hb = await getWorkerHeartbeat();
  assert.equal(hb.alive, true);
  assert.equal(hb.lastSeenAt, payload.lastSeenAt);
  assert.deepEqual(
    hb.diagnostics?.find((d) => d.code === WORKER_SENTINEL.code),
    WORKER_SENTINEL,
  );

  // Graceful stop deletes the key → immediate "down".
  await stop();
  assert.deepEqual(await getWorkerHeartbeat(), { alive: false });
});

test("read leg: legacy bare-timestamp payload still reads as alive", async () => {
  // A pre-diagnostics worker (mixed-version deploy window) writes the bare
  // ISO string. Liveness must keep working; diagnostics degrade to absent.
  stored = "2026-07-25T09:00:00.000Z";
  const hb = await getWorkerHeartbeat();
  assert.equal(hb.alive, true);
  assert.equal(hb.lastSeenAt, "2026-07-25T09:00:00.000Z");
  assert.equal(hb.diagnostics, undefined);
});

test("read leg: malformed JSON payload degrades to bare liveness, never throws", async () => {
  stored = '{"lastSeenAt": definitely broken';
  const hb = await getWorkerHeartbeat();
  // Key presence alone proves a worker wrote recently → alive; everything
  // else about the payload is untrusted and degrades.
  assert.equal(hb.alive, true);
  assert.equal(hb.lastSeenAt, undefined);
  assert.equal(hb.diagnostics, undefined);
});

test("read leg: malformed diagnostics entries are dropped entry-by-entry", async () => {
  // One garbage entry (a foreign writer, a truncated payload) must not
  // discard the valid ones — and extra fields must not smuggle through to
  // the admin response.
  stored = JSON.stringify({
    lastSeenAt: "2026-07-25T10:00:00.000Z",
    diagnostics: [
      { code: 42, message: "code is not a string" },
      "not an object",
      { code: "test.valid-entry", message: "valid", extra: "stripped" },
    ],
  });
  const hb = await getWorkerHeartbeat();
  assert.equal(hb.alive, true);
  assert.deepEqual(hb.diagnostics, [
    { code: "test.valid-entry", message: "valid" },
  ]);
});
