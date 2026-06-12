import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// Capture-pipeline writes land on a PROTOTYPE spy (posthog-node defines
// `capture` on PostHog.prototype, so instances created inside the plugin
// inherit the spy) — `vi.mock("posthog-node")` can't reach the plugin's own
// import when the workspace package is externalized, a prototype spy can.
const { PostHog } = await import("posthog-node");
const captureSpy = vi
  .spyOn(PostHog.prototype, "capture")
  .mockImplementation(() => {});

const { derivePrivateHost, createPostHogProvider, getPersonProperties } =
  await import("@hogsend/plugin-posthog");

describe("derivePrivateHost", () => {
  it("strips the Cloud ingestion label", () => {
    expect(derivePrivateHost("https://eu.i.posthog.com")).toBe(
      "https://eu.posthog.com",
    );
    expect(derivePrivateHost("https://us.i.posthog.com")).toBe(
      "https://us.posthog.com",
    );
  });

  it("passes self-hosted and app hosts through unchanged", () => {
    expect(derivePrivateHost("https://posthog.internal.example.com")).toBe(
      "https://posthog.internal.example.com",
    );
    expect(derivePrivateHost("https://eu.posthog.com")).toBe(
      "https://eu.posthog.com",
    );
  });
});

describe("createPostHogProvider", () => {
  beforeEach(() => captureSpy.mockClear());

  it("reports personReads by personal-key presence", () => {
    const without = createPostHogProvider({ apiKey: "phc_x" });
    expect(without.meta.id).toBe("posthog");
    expect(without.capabilities.personReads).toBe(false);
    expect(without.capabilities.personWrites).toBe(true);

    const with_ = createPostHogProvider({
      apiKey: "phc_x",
      personalApiKey: "phx_y",
    });
    expect(with_.capabilities.personReads).toBe(true);
  });

  it("setPersonProperties rides the capture pipeline as $set/$set_once/$unset", async () => {
    const provider = createPostHogProvider({ apiKey: "phc_x" });
    await provider.setPersonProperties({
      distinctId: "u_1",
      set: { plan: "pro" },
      setOnce: { firstPlan: "free" },
      unset: ["legacy_flag"],
    });
    expect(captureSpy).toHaveBeenCalledWith({
      distinctId: "u_1",
      event: "$set",
      properties: {
        $set: { plan: "pro" },
        $set_once: { firstPlan: "free" },
        $unset: ["legacy_flag"],
      },
    });
  });

  it("setPersonProperties no-ops on an empty write", async () => {
    const provider = createPostHogProvider({ apiKey: "phc_x" });
    await provider.setPersonProperties({ distinctId: "u_1" });
    expect(captureSpy).not.toHaveBeenCalled();
  });
});

describe("getPersonProperties (private API read)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is DISABLED (resolves {}) without a personal API key", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await getPersonProperties({
      config: { host: "https://eu.i.posthog.com" },
      distinctId: "u_1",
    });
    expect(result).toEqual({});
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("discovers the project id then reads from the env-scoped endpoint on the PRIVATE host", async () => {
    const calls: Array<{ url: string; auth?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({
          url,
          auth: (init?.headers as Record<string, string>)?.Authorization,
        });
        if (url.includes("/api/projects/@current/")) {
          return new Response(JSON.stringify({ id: 4242 }), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            results: [{ properties: { timezone: "Europe/London" } }],
          }),
          { status: 200 },
        );
      }),
    );

    const result = await getPersonProperties({
      config: {
        host: "https://eu.i.posthog.com",
        personalApiKey: "phx_test_1",
      },
      distinctId: "u_42",
    });

    expect(result).toEqual({ timezone: "Europe/London" });
    // Discovery on the APP host with the personal key…
    expect(calls[0]?.url).toBe("https://eu.posthog.com/api/projects/@current/");
    expect(calls[0]?.auth).toBe("Bearer phx_test_1");
    // …then the environment-scoped persons read, same host + key.
    expect(calls[1]?.url).toBe(
      "https://eu.posthog.com/api/environments/4242/persons/?distinct_id=u_42",
    );
    expect(calls[1]?.auth).toBe("Bearer phx_test_1");
  });

  it("skips discovery when projectId is configured and soft-fails on upstream errors", async () => {
    const fetchSpy = vi.fn(async (url: string) => {
      expect(url).toContain("/api/environments/77/persons/");
      return new Response("nope", { status: 403 });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await getPersonProperties({
      config: {
        host: "https://eu.i.posthog.com",
        personalApiKey: "phx_test_2",
        projectId: "77",
      },
      distinctId: "u_1",
    });
    expect(result).toEqual({});
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("container analytics resolution", () => {
  it("wraps a legacy PostHogService and exposes it as the active provider", async () => {
    const { createHogsendClient } = await import("@hogsend/engine");
    const identify = vi.fn();
    const legacyCapture = vi.fn();
    const legacy = {
      getPersonProperties: vi.fn(async () => ({ tz: "UTC" })),
      captureEvent: legacyCapture,
      identify,
      isFeatureEnabled: vi.fn(async () => false),
      shutdown: vi.fn(async () => {}),
    };

    const client = createHogsendClient({ analytics: legacy });
    expect(client.analytics).toBeDefined();
    expect(client.analytics?.meta.id).toBe("custom");

    await client.analytics?.setPersonProperties({
      distinctId: "u_1",
      set: { plan: "pro" },
      unset: ["old"],
    });
    expect(identify).toHaveBeenCalledWith("u_1", { plan: "pro" });
    expect(legacyCapture).toHaveBeenCalledWith({
      distinctId: "u_1",
      event: "$set",
      properties: { $unset: ["old"] },
    });
    await client.dbClient.end({ timeout: 5 }).catch(() => {});
  });

  it("throws on an unregistered analytics.defaultProvider", async () => {
    const { createHogsendClient } = await import("@hogsend/engine");
    expect(() =>
      createHogsendClient({ analytics: { defaultProvider: "amplitude" } }),
    ).toThrow(/not a registered analytics provider/);
  });
});
