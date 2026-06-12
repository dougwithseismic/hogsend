import {
  ABSENT_RECHECK_MS,
  createTokenManager,
  FAILURE_BACKOFF_MS,
  HOGSEND_POSTHOG_CLIENT_ID,
  type Logger,
  type OAuthCredentialPayload,
} from "@hogsend/engine";
import { describe, expect, it, vi } from "vitest";

const T0 = Date.parse("2026-06-12T10:00:00Z");

const basePayload: OAuthCredentialPayload = {
  accessToken: "pha_old",
  refreshToken: "phr_keep",
  expiresAt: new Date(T0 + 10 * 3_600_000).toISOString(),
  tokenEndpoint: "https://eu.posthog.com/oauth/token/",
  clientId: HOGSEND_POSTHOG_CLIENT_ID,
  scopes: ["person:read", "person:write", "project:read", "hog_function:write"],
  scopedTeams: [],
  scopedOrganizations: [],
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const okTokenBody = {
  access_token: "pha_new",
  expires_in: 36_000,
};

/**
 * Stateful harness: the store round-trips through `state.stored` (save
 * updates what the next load returns — the DB-row-is-shared-truth model) and
 * the clock is a mutable `nowMs`.
 */
function makeHarness(opts?: {
  stored?: Record<string, unknown> | null;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
}) {
  let nowMs = T0;
  const state = {
    stored:
      opts?.stored === undefined
        ? ({ ...basePayload } as Record<string, unknown> | null)
        : opts.stored,
  };
  const load = vi.fn(async () => state.stored);
  const save = vi.fn(async (p: OAuthCredentialPayload) => {
    state.stored = { ...p };
  });
  const logger = { warn: vi.fn(), debug: vi.fn() };
  const fetchImpl = vi.fn(
    opts?.fetchImpl ??
      (async () => {
        throw new Error("fetch not expected in this test");
      }),
  );
  const manager = createTokenManager({
    providerId: "posthog",
    store: { load, save },
    logger: logger as unknown as Logger,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    now: () => nowMs,
  });
  return {
    manager,
    load,
    save,
    logger,
    state,
    fetchImpl,
    advance: (ms: number) => {
      nowMs += ms;
    },
    now: () => nowMs,
  };
}

describe("createTokenManager", () => {
  it("returns a fresh token from memory: loads once, never fetches", async () => {
    const h = makeHarness();
    await expect(h.manager.getAccessToken()).resolves.toBe("pha_old");
    await expect(h.manager.getAccessToken()).resolves.toBe("pha_old");
    expect(h.load).toHaveBeenCalledTimes(1);
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it("applies the 60s expiry skew", async () => {
    const above = makeHarness({
      stored: {
        ...basePayload,
        expiresAt: new Date(T0 + 61_000).toISOString(),
      },
    });
    await expect(above.manager.getAccessToken()).resolves.toBe("pha_old");
    expect(above.fetchImpl).not.toHaveBeenCalled();

    const below = makeHarness({
      stored: {
        ...basePayload,
        expiresAt: new Date(T0 + 59_000).toISOString(),
      },
      fetchImpl: async () => jsonResponse(okTokenBody),
    });
    await expect(below.manager.getAccessToken()).resolves.toBe("pha_new");
    expect(below.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("sends the public-client refresh wire format", async () => {
    const h = makeHarness({
      stored: { ...basePayload, expiresAt: new Date(T0 - 1000).toISOString() },
      fetchImpl: async () => jsonResponse(okTokenBody),
    });
    await h.manager.getAccessToken();

    const [url, init] = h.fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(basePayload.tokenEndpoint);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(headers.Authorization).toBeUndefined();
    const body = new URLSearchParams(init.body as string);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("phr_keep");
    expect(body.get("client_id")).toBe(HOGSEND_POSTHOG_CLIENT_ID);
  });

  it("stores a rotated refresh token (and splits the scope string)", async () => {
    const h = makeHarness({
      stored: { ...basePayload, expiresAt: new Date(T0 - 1000).toISOString() },
      fetchImpl: async () =>
        jsonResponse({
          ...okTokenBody,
          refresh_token: "phr_new",
          scope: "person:read person:write",
        }),
    });
    await expect(h.manager.getAccessToken()).resolves.toBe("pha_new");
    expect(h.save).toHaveBeenCalledTimes(1);
    expect(h.save).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: "pha_new",
        refreshToken: "phr_new",
        expiresAt: new Date(T0 + 36_000_000).toISOString(),
        scopes: ["person:read", "person:write"],
      }),
    );
  });

  it("KEEPS the old refresh token (and scopes) when the response omits them", async () => {
    const h = makeHarness({
      stored: { ...basePayload, expiresAt: new Date(T0 - 1000).toISOString() },
      fetchImpl: async () => jsonResponse(okTokenBody),
    });
    await expect(h.manager.getAccessToken()).resolves.toBe("pha_new");
    expect(h.save).toHaveBeenCalledWith(
      expect.objectContaining({
        refreshToken: "phr_keep",
        scopes: basePayload.scopes,
      }),
    );
  });

  it("single-flights concurrent refreshes", async () => {
    let release!: (r: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const h = makeHarness({
      stored: { ...basePayload, expiresAt: new Date(T0 - 1000).toISOString() },
      fetchImpl: () => gate,
    });

    const p1 = h.manager.getAccessToken();
    const p2 = h.manager.getAccessToken();
    release(jsonResponse(okTokenBody));
    await expect(p1).resolves.toBe("pha_new");
    await expect(p2).resolves.toBe("pha_new");
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    expect(h.save).toHaveBeenCalledTimes(1);
  });

  it("refresh failure: null, warn-once, backoff, recovery re-arms the warn", async () => {
    let mode: "fail" | "ok" = "fail";
    const h = makeHarness({
      stored: { ...basePayload, expiresAt: new Date(T0 - 1000).toISOString() },
      fetchImpl: async () =>
        mode === "fail"
          ? jsonResponse({ error: "invalid_grant" }, 400)
          : jsonResponse({
              access_token: "pha_new2",
              refresh_token: "phr_new2",
              expires_in: 36_000,
            }),
    });

    // First failure: warn exactly once, with the detail + remediation.
    await expect(h.manager.getAccessToken()).resolves.toBeNull();
    expect(h.logger.warn).toHaveBeenCalledTimes(1);
    const warned = h.logger.warn.mock.calls[0]?.[0] as string;
    expect(warned).toContain("invalid_grant");
    expect(warned).toContain("hogsend connect posthog");

    // Immediate retry: failure backoff — no second fetch, no second warn.
    await expect(h.manager.getAccessToken()).resolves.toBeNull();
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    expect(h.logger.warn).toHaveBeenCalledTimes(1);

    // Past the backoff: re-attempts, still failing → repeat logs at debug.
    h.advance(FAILURE_BACKOFF_MS + 1);
    await expect(h.manager.getAccessToken()).resolves.toBeNull();
    expect(h.fetchImpl).toHaveBeenCalledTimes(2);
    expect(h.logger.warn).toHaveBeenCalledTimes(1);
    expect(h.logger.debug).toHaveBeenCalled();

    // Recovery resets the latch…
    mode = "ok";
    h.advance(FAILURE_BACKOFF_MS + 1);
    await expect(h.manager.getAccessToken()).resolves.toBe("pha_new2");

    // …so the NEXT failure streak warns again.
    mode = "fail";
    h.advance(36_000_000 + 1);
    await expect(h.manager.getAccessToken()).resolves.toBeNull();
    expect(h.logger.warn).toHaveBeenCalledTimes(2);
  });

  it("returns the still-live old token when refresh fails inside the skew window", async () => {
    const h = makeHarness({
      stored: {
        ...basePayload,
        expiresAt: new Date(T0 + 30_000).toISOString(),
      },
      fetchImpl: async () => jsonResponse({ error: "server_error" }, 500),
    });
    await expect(h.manager.getAccessToken()).resolves.toBe("pha_old");
  });

  it("absent credential: no warn, negative cache, runtime-connect pickup", async () => {
    const h = makeHarness({ stored: null });

    await expect(h.manager.getAccessToken()).resolves.toBeNull();
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(h.logger.warn).not.toHaveBeenCalled();
    expect(h.manager.credentialState()).toBe("absent");

    // Within the negative-cache window: no second load.
    await expect(h.manager.getAccessToken()).resolves.toBeNull();
    expect(h.load).toHaveBeenCalledTimes(1);

    // `hogsend connect posthog` stores a credential → picked up ≤30s later.
    h.state.stored = { ...basePayload };
    h.advance(ABSENT_RECHECK_MS + 1);
    await expect(h.manager.getAccessToken()).resolves.toBe("pha_old");
    expect(h.manager.credentialState()).toBe("present");
  });

  it("reloads before refreshing and adopts another process's refresh", async () => {
    const h = makeHarness({
      stored: { ...basePayload, expiresAt: new Date(T0 - 1000).toISOString() },
      fetchImpl: async () => jsonResponse({ error: "invalid_grant" }, 400),
    });

    await expect(h.manager.getAccessToken()).resolves.toBeNull();
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);

    // The sibling process refreshed and persisted a fresh row.
    h.state.stored = { ...basePayload, accessToken: "pha_other_proc" };
    h.advance(FAILURE_BACKOFF_MS + 1);
    await expect(h.manager.getAccessToken()).resolves.toBe("pha_other_proc");
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    expect(h.save).not.toHaveBeenCalled();
  });

  it("malformed payload: null + warn-once + no fetch", async () => {
    const h = makeHarness({ stored: { garbage: true } });
    await expect(h.manager.getAccessToken()).resolves.toBeNull();
    expect(h.logger.warn).toHaveBeenCalledTimes(1);
    expect(h.logger.warn.mock.calls[0]?.[0]).toContain(
      "hogsend connect posthog",
    );
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(h.manager.credentialState()).toBe("absent");
  });

  it("surfaces a store load failure's message verbatim (decrypt error path)", async () => {
    const h = makeHarness();
    h.load.mockRejectedValue(
      new Error(
        'Stored credential for "posthog" cannot be decrypted — ' +
          "BETTER_AUTH_SECRET may have rotated. Re-connect the provider or " +
          "delete the credential.",
      ),
    );
    await expect(h.manager.getAccessToken()).resolves.toBeNull();
    expect(h.logger.warn).toHaveBeenCalledTimes(1);
    expect(h.logger.warn.mock.calls[0]?.[0]).toContain(
      "BETTER_AUTH_SECRET may have rotated",
    );
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it("does not lose the refreshed token when store.save fails", async () => {
    const h = makeHarness({
      stored: { ...basePayload, expiresAt: new Date(T0 - 1000).toISOString() },
      fetchImpl: async () => jsonResponse(okTokenBody),
    });
    h.save.mockRejectedValue(new Error("db down"));

    await expect(h.manager.getAccessToken()).resolves.toBe("pha_new");
    expect(h.logger.warn).toHaveBeenCalledTimes(1);
    expect(h.logger.warn.mock.calls[0]?.[0]).toContain("db down");

    // Adopted in memory: a second call serves from cache without fetching.
    await expect(h.manager.getAccessToken()).resolves.toBe("pha_new");
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("prime() is load-only: never refreshes, even when expired", async () => {
    const h = makeHarness({
      stored: { ...basePayload, expiresAt: new Date(T0 - 1000).toISOString() },
    });
    await h.manager.prime();
    expect(h.manager.credentialState()).toBe("present");
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it("throws at construction without db or store", () => {
    expect(() => createTokenManager({ providerId: "posthog" })).toThrow(
      /db or store/,
    );
  });
});
