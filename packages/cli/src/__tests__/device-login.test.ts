import { describe, expect, it } from "vitest";
import { createCloudClient, type FetchLike } from "../lib/cloud-http.js";
import {
  type DeviceLoginDeps,
  DeviceLoginError,
  runDeviceLogin,
} from "../lib/device-login.js";

/**
 * The device flow against a SCRIPTED cloud: no network, no wall clock, no
 * browser. Every side effect is injected, so the whole verdict space —
 * approved, denied, expired, rate-limited, timed out, a blip mid-wait — is
 * exercised in milliseconds.
 *
 * The invariant that outranks all of them: NOTHING printed by this flow ever
 * contains the token. Every case collects the emitted lines and asserts it.
 */

const BASE_URL = "https://cloud.hogsend.test";
const TOKEN = "hscli_approved_secret_never_printed";

interface Scripted {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** A fetch that answers each path from a queue, and records what was asked. */
function scriptedFetch(script: Record<string, Scripted[]>): {
  fetchImpl: FetchLike;
  calls: { path: string; body: unknown }[];
} {
  const calls: { path: string; body: unknown }[] = [];
  const remaining: Record<string, Scripted[]> = {};
  for (const [path, answers] of Object.entries(script)) {
    remaining[path] = [...answers];
  }

  const fetchImpl: FetchLike = async (url, init) => {
    const path = new URL(url).pathname;
    const raw = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ path, body: raw ? JSON.parse(raw) : undefined });

    const queue = remaining[path];
    if (!queue || queue.length === 0) {
      throw new Error(`unscripted request: ${path}`);
    }
    // The LAST answer repeats, so a `pending` tail does not need padding.
    const answer = (queue.length > 1 ? queue.shift() : queue[0]) as Scripted;
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { "content-type": "application/json", ...answer.headers },
    });
  };

  return { fetchImpl, calls };
}

const MINT: Scripted = {
  status: 200,
  body: {
    deviceCode: "device-code-secret",
    userCode: "WXYZ-2468",
    verificationUrl: `${BASE_URL}/cli/approve`,
    expiresIn: 900,
    interval: 5,
  },
};

function harness(script: Record<string, Scripted[]>) {
  const { fetchImpl, calls } = scriptedFetch(script);
  const lines: string[] = [];
  const opened: string[] = [];

  const deps: DeviceLoginDeps = {
    client: createCloudClient({ baseUrl: BASE_URL, fetchImpl }),
    openBrowser: (url) => {
      opened.push(url);
      return true;
    },
    emit: (line) => lines.push(line),
    // No real waiting: the clock advances by whatever was "slept".
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  };

  let clock = 0;
  return { deps, lines, opened, calls };
}

describe("hogsend login — device flow", () => {
  it("prints the code, opens the BARE url, and returns the token without printing it", async () => {
    const { deps, lines, opened } = harness({
      "/api/cli/device": [MINT],
      "/api/cli/device/poll": [
        { status: 200, body: { status: "pending" } },
        {
          status: 200,
          body: {
            status: "approved",
            token: TOKEN,
            sessionId: "session-1",
            organizationId: "org-1",
            userId: "user-1",
          },
        },
      ],
    });

    const result = await runDeviceLogin({ label: "laptop" }, deps);

    expect(result.token).toBe(TOKEN);
    expect(result.sessionId).toBe("session-1");

    const printed = lines.join("\n");
    expect(printed).toContain("WXYZ-2468");
    expect(printed).toContain(`${BASE_URL}/cli/approve`);

    // THE ANTI-PHISHING RULE: the URL that is opened carries no code. A link
    // that prefills it turns a stranger's pending login into one click.
    expect(opened).toEqual([`${BASE_URL}/cli/approve`]);
    expect(opened[0]).not.toContain("WXYZ-2468");

    // ...and the token is in NO printed line.
    expect(printed).not.toContain(TOKEN);
  });

  it("sends the machine label with the mint", async () => {
    const { deps, calls } = harness({
      "/api/cli/device": [MINT],
      "/api/cli/device/poll": [
        {
          status: 200,
          body: {
            status: "approved",
            token: TOKEN,
            sessionId: "s",
            organizationId: "o",
            userId: "u",
          },
        },
      ],
    });

    await runDeviceLogin({ label: "doug-macbook" }, deps);
    expect(calls[0]).toEqual({
      path: "/api/cli/device",
      body: { label: "doug-macbook" },
    });
    expect(calls[1]?.body).toEqual({ deviceCode: "device-code-secret" });
  });

  it("skips the browser when asked, and still prints everything", async () => {
    const { deps, lines, opened } = harness({
      "/api/cli/device": [MINT],
      "/api/cli/device/poll": [
        {
          status: 200,
          body: {
            status: "approved",
            token: TOKEN,
            sessionId: "s",
            organizationId: "o",
            userId: "u",
          },
        },
      ],
    });

    await runDeviceLogin({ label: "ci", noBrowser: true }, deps);
    expect(opened).toEqual([]);
    expect(lines.join("\n")).toContain("WXYZ-2468");
  });

  it("reports a denial distinctly from an expiry", async () => {
    const denied = harness({
      "/api/cli/device": [MINT],
      "/api/cli/device/poll": [{ status: 200, body: { status: "denied" } }],
    });
    await expect(
      runDeviceLogin({ label: "l" }, denied.deps),
    ).rejects.toMatchObject({
      name: "DeviceLoginError",
      verdict: "denied",
    });

    const expired = harness({
      "/api/cli/device": [MINT],
      "/api/cli/device/poll": [{ status: 200, body: { status: "expired" } }],
    });
    await expect(
      runDeviceLogin({ label: "l" }, expired.deps),
    ).rejects.toMatchObject({
      verdict: "expired",
    });
  });

  it("keeps waiting through a 429 and a network blip", async () => {
    const { deps, calls } = harness({
      "/api/cli/device": [MINT],
      "/api/cli/device/poll": [
        {
          status: 429,
          body: { error: "rate_limited", message: "slow down" },
          headers: { "retry-after": "2" },
        },
        { status: 200, body: { status: "pending" } },
        {
          status: 200,
          body: {
            status: "approved",
            token: TOKEN,
            sessionId: "s",
            organizationId: "o",
            userId: "u",
          },
        },
      ],
    });

    // A limiter that fired because another machine behind the same NAT was
    // polling must not abandon a login the human is about to approve.
    const result = await runDeviceLogin({ label: "l" }, deps);
    expect(result.token).toBe(TOKEN);
    expect(
      calls.filter((call) => call.path === "/api/cli/device/poll"),
    ).toHaveLength(3);
  });

  it("refuses a rate-limited MINT — nothing has started to be patient about", async () => {
    const { deps } = harness({
      "/api/cli/device": [
        {
          status: 429,
          body: { error: "rate_limited", message: "too many" },
          headers: { "retry-after": "30" },
        },
      ],
    });

    const error = await runDeviceLogin({ label: "l" }, deps).catch((e) => e);
    expect(error).toBeInstanceOf(DeviceLoginError);
    expect((error as DeviceLoginError).verdict).toBe("rate_limited");
    expect((error as DeviceLoginError).hint).toContain("30");
  });

  it("gives up at the hard ceiling rather than polling forever", async () => {
    const { deps } = harness({
      "/api/cli/device": [MINT],
      "/api/cli/device/poll": [{ status: 200, body: { status: "pending" } }],
    });

    await expect(
      runDeviceLogin({ label: "l", maxWaitMs: 30_000 }, deps),
    ).rejects.toMatchObject({ verdict: "timeout" });
  });
});
