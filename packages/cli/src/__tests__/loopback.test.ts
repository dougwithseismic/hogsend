import { createServer as createNetServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  LoopbackError,
  type LoopbackServer,
  startLoopbackServer,
} from "../lib/loopback.js";

/**
 * Real node:http servers throughout — production passes LOOPBACK_PORTS, but
 * tests inject `ports: [0]` for ephemeral binds so CI never collides.
 */

const STATE = "S";
const loopbacks: LoopbackServer[] = [];
const blockers: Server[] = [];

afterEach(async () => {
  for (const server of loopbacks.splice(0)) {
    await server.close();
  }
  for (const server of blockers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function start(ports: readonly number[] = [0], state = STATE) {
  const server = await startLoopbackServer({ ports, state });
  loopbacks.push(server);
  return server;
}

/** Bind a throwaway TCP server to occupy an ephemeral port. */
function occupyPort(): Promise<{ port: number; server: Server }> {
  return new Promise((resolve) => {
    const server = createNetServer();
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      const port =
        address !== null && typeof address === "object" ? address.port : 0;
      blockers.push(server);
      resolve({ port, server });
    });
  });
}

const expectLoopbackRejection = async (
  promise: Promise<unknown>,
  reason: string,
) => {
  await expect(promise).rejects.toSatisfy((err: unknown) => {
    expect(err).toBeInstanceOf(LoopbackError);
    expect((err as LoopbackError).reason).toBe(reason);
    return true;
  });
};

describe("startLoopbackServer", () => {
  it("happy path: success page + resolved code", async () => {
    const server = await start();
    const wait = server.waitForCallback();

    const res = await fetch(`${server.redirectUri}?code=abc&state=${STATE}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Connected");

    await expect(wait).resolves.toEqual({ code: "abc" });
  });

  it("rejects state_mismatch with HTTP 400", async () => {
    const server = await start();
    // Attach the rejection handler BEFORE triggering the callback, so the
    // rejection is never momentarily unhandled.
    const assertion = expectLoopbackRejection(
      server.waitForCallback(),
      "state_mismatch",
    );

    const res = await fetch(`${server.redirectUri}?code=abc&state=WRONG`);
    expect(res.status).toBe(400);

    await assertion;
  });

  it("rejects consent_denied on error=access_denied", async () => {
    const server = await start();
    const assertion = expectLoopbackRejection(
      server.waitForCallback(),
      "consent_denied",
    );

    const res = await fetch(
      `${server.redirectUri}?error=access_denied&state=${STATE}`,
    );
    expect(res.status).toBe(200);

    await assertion;
  });

  it("404s wrong paths and keeps the wait pending", async () => {
    const server = await start();
    const wait = server.waitForCallback();

    const res = await fetch(`http://127.0.0.1:${server.port}/nope`);
    expect(res.status).toBe(404);

    // Still pending: a sentinel wins the race.
    const pending = await Promise.race([
      wait.then(() => "settled"),
      new Promise((resolve) => setTimeout(() => resolve("pending"), 50)),
    ]);
    expect(pending).toBe("pending");

    // Settle it for cleanup symmetry.
    await fetch(`${server.redirectUri}?code=abc&state=${STATE}`);
    await expect(wait).resolves.toEqual({ code: "abc" });
  });

  it("falls back to the next port when the first is busy", async () => {
    const { port } = await occupyPort();
    const server = await start([port, 0]);
    expect(server.port).not.toBe(port);
    expect(server.port).toBeGreaterThan(0);
  });

  it("rejects ports_busy listing the ports when all are taken", async () => {
    const { port } = await occupyPort();
    await expect(
      startLoopbackServer({ ports: [port], state: STATE }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(LoopbackError);
      expect((err as LoopbackError).reason).toBe("ports_busy");
      expect((err as LoopbackError).message).toContain(String(port));
      return true;
    });
  });

  it("times out when no callback arrives", async () => {
    const server = await start();
    await expectLoopbackRejection(
      server.waitForCallback({ timeoutMs: 20 }),
      "timeout",
    );
  });

  it("first answer wins — later requests get a 410", async () => {
    const server = await start();
    const wait = server.waitForCallback();

    const first = await fetch(`${server.redirectUri}?code=abc&state=${STATE}`);
    expect(first.status).toBe(200);
    await expect(wait).resolves.toEqual({ code: "abc" });

    const second = await fetch(
      `${server.redirectUri}?code=later&state=${STATE}`,
    );
    expect(second.status).toBe(410);
  });
});
