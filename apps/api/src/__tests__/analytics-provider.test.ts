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
// `mergeIdentities` maps to the native `client.alias` wire (anon-absorb merge);
// like `capture`, it is defined on PostHog.prototype, so a prototype spy
// catches the call the externalized plugin makes on its own instance.
const aliasSpy = vi
  .spyOn(PostHog.prototype, "alias")
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

  it("capabilities.personReads is LIVE over the OAuth accessor (+ oauth flag)", () => {
    let avail = false;
    const provider = createPostHogProvider({
      apiKey: "phc_x",
      authToken: {
        getToken: async () => null,
        isAvailable: () => avail,
      },
    });
    expect(provider.capabilities.personReads).toBe(false);
    expect(provider.capabilities.oauth).toBe(true);
    // Same instance flips when the credential lands (runtime connect) —
    // no provider rebuild.
    avail = true;
    expect(provider.capabilities.personReads).toBe(true);
  });
});

// ===========================================================================
// MF-1 — the alias-direction footgun, asserted as a code-review LAW.
//
// `mergeIdentities({ distinctId, alias })` MUST map to
// `client.alias({ distinctId, alias })` UNCHANGED, where:
//   • distinctId = the SURVIVING / canonical (identified) contact key, and
//   • alias      = the ABSORBED (anonymous) id (never identified).
//
// The posthog-node `.d.ts` JSDoc shows the example BACKWARDS
// (`distinctId: 'anonymous_123', alias: 'user_456'` — anon as distinctId,
// identified as alias). An implementer who copies the `.d.ts` writes the merge
// inverted, makes the canonical key the absorbed side, and BURNS it (PostHog
// refuses the merge). These assertions guard against the DOCS rule, never the
// `.d.ts` example.
// ===========================================================================
describe("mergeIdentities — alias direction (MF-1, docs rule not .d.ts)", () => {
  beforeEach(() => aliasSpy.mockClear());

  it("declares identityMerge=true and exposes the mergeIdentities wire", () => {
    const provider = createPostHogProvider({ apiKey: "phc_x" });
    expect(provider.capabilities.identityMerge).toBe(true);
    expect(typeof provider.mergeIdentities).toBe("function");
  });

  it("maps {distinctId, alias} STRAIGHT THROUGH to client.alias — survivor=distinctId, absorbed=alias", () => {
    const provider = createPostHogProvider({ apiKey: "phc_x" });
    // distinctId = the canonical, ever-identified contact key (the survivor).
    // alias      = the absorbed anonymous browser-session id.
    provider.mergeIdentities?.({
      distinctId: "canonical-contact-key",
      alias: "anon-session-id",
    });

    expect(aliasSpy).toHaveBeenCalledTimes(1);
    const arg = aliasSpy.mock.calls[0]?.[0];
    // The SURVIVOR is the FIRST arg (distinctId); the ABSORBED anon id is the
    // SECOND (alias). This is the whole law: if these two were swapped the
    // canonical key would be burned.
    expect(arg?.distinctId).toBe("canonical-contact-key");
    expect(arg?.alias).toBe("anon-session-id");
  });

  it("does NOT invert the direction (guards against the .d.ts example)", () => {
    const provider = createPostHogProvider({ apiKey: "phc_x" });
    provider.mergeIdentities?.({
      distinctId: "survivor-canon",
      alias: "absorbed-anon",
    });

    const arg = aliasSpy.mock.calls[0]?.[0];
    // Explicitly reject the .d.ts shape: the anon id must NEVER land as
    // distinctId, and the canonical key must NEVER land as alias (which would
    // try to absorb an identified key and PostHog would refuse).
    expect(arg?.distinctId).not.toBe("absorbed-anon");
    expect(arg?.alias).not.toBe("survivor-canon");
    // And the survivor is never passed as the absorbed `alias` arg.
    expect(arg?.alias).not.toBe(arg?.distinctId);
  });

  it("no-ops on a self-alias (distinctId === alias) — keeps the Part-1 zero-merge case free", () => {
    const provider = createPostHogProvider({ apiKey: "phc_x" });
    provider.mergeIdentities?.({ distinctId: "same-key", alias: "same-key" });
    expect(aliasSpy).not.toHaveBeenCalled();
  });

  it("no-ops on an empty distinctId or alias (never sends a malformed merge)", () => {
    const provider = createPostHogProvider({ apiKey: "phc_x" });
    provider.mergeIdentities?.({ distinctId: "", alias: "anon" });
    provider.mergeIdentities?.({ distinctId: "canon", alias: "" });
    expect(aliasSpy).not.toHaveBeenCalled();
  });

  it("legacy PostHogService adapter exposes NO merge wire (helper no-ops, never mis-stitches)", async () => {
    const { createHogsendClient } = await import("@hogsend/engine");
    const legacy = {
      getPersonProperties: vi.fn(async () => ({})),
      captureEvent: vi.fn(),
      identify: vi.fn(),
      isFeatureEnabled: vi.fn(async () => false),
      shutdown: vi.fn(async () => {}),
    };
    const client = createHogsendClient({ analytics: legacy });

    // A hand-built legacy service has no alias wire: identityMerge stays
    // absent/falsy and mergeIdentities is undefined → the engine helper no-ops
    // rather than firing a backwards or no-op alias.
    expect(client.analytics?.capabilities.identityMerge).toBeFalsy();
    expect(client.analytics?.mergeIdentities).toBeUndefined();
    expect(aliasSpy).not.toHaveBeenCalled();

    await client.dbClient.end({ timeout: 5 }).catch(() => {});
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

  it("prefers the OAuth token over the personal key", async () => {
    const fetchSpy = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ results: [{ properties: {} }] }), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    await getPersonProperties({
      config: {
        host: "https://oauth-pref.i.posthog.com",
        personalApiKey: "phx_fb",
        getAuthToken: async () => "pha_live",
        projectId: "77",
      },
      distinctId: "u_1",
    });

    const headers = fetchSpy.mock.calls[0]?.[1]?.headers as Record<
      string,
      string
    >;
    expect(headers.Authorization).toBe("Bearer pha_live");
  });

  it("falls back to the personal key when the accessor yields null", async () => {
    const fetchSpy = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ results: [{ properties: {} }] }), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    await getPersonProperties({
      config: {
        host: "https://oauth-fb.i.posthog.com",
        personalApiKey: "phx_fb",
        getAuthToken: async () => null,
        projectId: "77",
      },
      distinctId: "u_1",
    });

    const headers = fetchSpy.mock.calls[0]?.[1]?.headers as Record<
      string,
      string
    >;
    expect(headers.Authorization).toBe("Bearer phx_fb");
  });

  it("is NOT gated when only the OAuth accessor is configured", async () => {
    const fetchSpy = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ results: [{ properties: {} }] }), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    await getPersonProperties({
      config: {
        host: "https://oauth-only.i.posthog.com",
        getAuthToken: async () => "pha_only",
        projectId: "77",
      },
      distinctId: "u_1",
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const headers = fetchSpy.mock.calls[0]?.[1]?.headers as Record<
      string,
      string
    >;
    expect(headers.Authorization).toBe("Bearer pha_only");
  });

  it("keeps the project-id discovery cache stable across token rotation", async () => {
    const calls: Array<{ url: string; auth?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({
          url,
          auth: (init?.headers as Record<string, string>)?.Authorization,
        });
        if (url.includes("/api/projects/@current/")) {
          return new Response(JSON.stringify({ id: 9090 }), { status: 200 });
        }
        return new Response(JSON.stringify({ results: [{ properties: {} }] }), {
          status: 200,
        });
      }),
    );

    // pha_ tokens rotate ~10h; the discovery cache must NOT key on them.
    const tokens = ["pha_1", "pha_2"];
    const config = {
      host: "https://oauth-rotate.i.posthog.com",
      getAuthToken: async () => tokens.shift() ?? null,
    };

    await getPersonProperties({ config, distinctId: "u_1" });
    await getPersonProperties({ config, distinctId: "u_2" });

    const discoveries = calls.filter((c) =>
      c.url.includes("/api/projects/@current/"),
    );
    expect(discoveries).toHaveLength(1);
    const personReads = calls.filter((c) => c.url.includes("/persons/"));
    expect(personReads[0]?.auth).toBe("Bearer pha_1");
    expect(personReads[1]?.auth).toBe("Bearer pha_2");
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

describe("factory nudge — truthful after prime settles", () => {
  it("logs DISABLED only when prime finds no credential and no personal key", async () => {
    const { analyticsProvidersFromEnv, env } = await import("@hogsend/engine");
    const infos: string[] = [];
    const logger = {
      info: (m: string) => infos.push(m),
      warn() {},
      error() {},
      debug() {},
    };
    // env preset requires POSTHOG_API_KEY; ensure no personal key for the test.
    const testEnv = {
      ...env,
      POSTHOG_API_KEY: "phc_nudge_test",
      POSTHOG_PERSONAL_API_KEY: undefined,
    } as typeof env;
    // Store that reports NO credential — prime resolves to absent.
    const fakeDb = {
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => [] }),
        }),
      }),
    };
    analyticsProvidersFromEnv(testEnv, {
      db: fakeDb as never,
      logger: logger as never,
    });
    // prime is fire-and-forget — poll briefly instead of a fixed sleep so a
    // loaded parallel suite can't flake this.
    const deadline = Date.now() + 2_000;
    while (
      !infos.some((m) => m.includes("person reads DISABLED")) &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(infos.some((m) => m.includes("person reads DISABLED"))).toBe(true);
  });
});
