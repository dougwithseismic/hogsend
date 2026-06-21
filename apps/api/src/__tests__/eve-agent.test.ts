/**
 * Tests for the Eve agent integration (Phase 4 — Tier-3 churn-save).
 *
 * Covers:
 *  1. `eveSource` transform unit tests — payload → IngestEvent mapping.
 *  2. HTTP-level webhook route via `app.request()` — secret present/absent,
 *     correct/wrong secret, payload validation.
 *  3. `startEveSession` unit tests — fetch shape, error handling (using
 *     `vi.stubGlobal("fetch")`).
 */

import { createHmac } from "node:crypto";
import { createApp, createHogsendClient } from "@hogsend/engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eveSource } from "../webhook-sources/eve.js";
import { webhookSources } from "../webhook-sources/index.js";

// ---------------------------------------------------------------------------
// App fixture (mirrors webhook-sources.test.ts)
// ---------------------------------------------------------------------------

const container = createHogsendClient();
const app = createApp(container, { webhookSources });

/** A minimal context stub — the eveSource transform doesn't use db/logger. */
const ctx = { db: {} as never, logger: {} as never };

// ---------------------------------------------------------------------------
// 1. eveSource transform — unit
// ---------------------------------------------------------------------------

describe("eveSource transform", () => {
  const validPayload = {
    sessionId: "ses_abc123",
    userId: "user-456",
    event: "agent.completed",
    play: {
      action: "offer_discount",
      reason: "User showed high churn-risk signals.",
      detail: "Use code SAVE20 for 20% off.",
    },
  };

  it("maps a valid Eve callback to an IngestEvent", async () => {
    const result = await eveSource.transform(validPayload, ctx);

    expect(result).not.toBeNull();
    expect(result?.event).toBe("agent.completed");
    expect(result?.userId).toBe("user-456");
    expect(result?.userEmail).toBe("");
  });

  it("puts play fields into eventProperties as scalars", async () => {
    const result = await eveSource.transform(validPayload, ctx);

    expect(result?.eventProperties.sessionId).toBe("ses_abc123");
    expect(result?.eventProperties.playAction).toBe("offer_discount");
    expect(result?.eventProperties.playReason).toBe(
      "User showed high churn-risk signals.",
    );
    expect(result?.eventProperties.playDetail).toBe(
      "Use code SAVE20 for 20% off.",
    );
    expect(result?.eventProperties._eveSource).toBe(true);
  });

  it("omits playDetail from eventProperties when not provided", async () => {
    const noDetail = {
      ...validPayload,
      play: { action: "suppress", reason: "User recently re-engaged." },
    };
    const result = await eveSource.transform(noDetail, ctx);

    expect(result?.eventProperties.playDetail).toBeUndefined();
    expect(result?.eventProperties.playAction).toBe("suppress");
  });

  it("contactProperties is an empty object (no profile data)", async () => {
    const result = await eveSource.transform(validPayload, ctx);
    expect(result?.contactProperties).toEqual({});
  });

  it("returns null when userId is missing", async () => {
    const badPayload = { ...validPayload, userId: "" };
    const result = await eveSource.transform(badPayload, ctx);
    expect(result).toBeNull();
  });

  it("passes the event name through from the payload", async () => {
    const custom = { ...validPayload, event: "custom.completed" };
    const result = await eveSource.transform(custom, ctx);
    expect(result?.event).toBe("custom.completed");
  });
});

// ---------------------------------------------------------------------------
// 2. HTTP route — POST /v1/webhooks/eve via app.request()
// ---------------------------------------------------------------------------

const EVE_TEST_SECRET = "eve_test_secret_value_high_entropy";

/** HMAC-SHA256(secret, body) as lowercase hex — what eve-agent sends. */
function signEve(body: string, secret = EVE_TEST_SECRET): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

const validEveBody = JSON.stringify({
  sessionId: "ses_test",
  userId: "user-http-test",
  event: "agent.completed",
  play: {
    action: "offer_discount",
    reason: "Test reason.",
  },
});

describe("POST /v1/webhooks/eve (HTTP)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 404 for an unknown source", async () => {
    const res = await app.request("/v1/webhooks/nonexistent-source", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });

  it("FAILS CLOSED with 401 when EVE_WEBHOOK_SECRET is not configured", async () => {
    // No secret in the env at all — a signature source must reject, NOT pass
    // through open. Even a (here meaningless) signature header doesn't help.
    const res = await app.request("/v1/webhooks/eve", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-eve-signature": signEve(validEveBody),
      },
      body: validEveBody,
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 when the x-eve-signature header is missing", async () => {
    vi.stubEnv("EVE_WEBHOOK_SECRET", EVE_TEST_SECRET);
    const res = await app.request("/v1/webhooks/eve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: validEveBody,
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 for an incorrect signature", async () => {
    vi.stubEnv("EVE_WEBHOOK_SECRET", EVE_TEST_SECRET);
    const res = await app.request("/v1/webhooks/eve", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-eve-signature": signEve(validEveBody, "the-wrong-secret"),
      },
      body: validEveBody,
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 when the body is tampered after signing", async () => {
    vi.stubEnv("EVE_WEBHOOK_SECRET", EVE_TEST_SECRET);
    const signature = signEve(validEveBody);
    const res = await app.request("/v1/webhooks/eve", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-eve-signature": signature,
      },
      // Same signature, mutated body bytes → must not verify.
      body: `${validEveBody} `,
    });
    expect(res.status).toBe(401);
  });

  it("accepts a correctly HMAC-signed body (auth passes)", async () => {
    vi.stubEnv("EVE_WEBHOOK_SECRET", EVE_TEST_SECRET);
    const res = await app.request("/v1/webhooks/eve", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-eve-signature": signEve(validEveBody),
      },
      body: validEveBody,
    });
    // Auth passed — never 401/404. (200 on success, or 500 if ingest can't
    // reach a DB in this unit context — both prove the signature verified.)
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(404);
  });

  it("returns 400 for a malformed payload once the signature is valid", async () => {
    vi.stubEnv("EVE_WEBHOOK_SECRET", EVE_TEST_SECRET);
    // Sign the malformed-but-JSON body so auth passes and we reach schema parse.
    const badBody = JSON.stringify({ not: "an eve payload" });
    const res = await app.request("/v1/webhooks/eve", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-eve-signature": signEve(badBody),
      },
      body: badBody,
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid payload");
  });
});

// ---------------------------------------------------------------------------
// 3. startEveSession — fetch unit tests
// ---------------------------------------------------------------------------

describe("startEveSession()", () => {
  // Save real fetch and restore after each test.
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  async function importStartEveSession() {
    // Dynamic import so stubs are in place before the module runs.
    const { startEveSession } = await import("../lib/eve.js");
    return startEveSession;
  }

  it("throws when EVE_BASE_URL is not set", async () => {
    vi.stubEnv("EVE_BASE_URL", "");
    vi.stubEnv("EVE_TOKEN", "tok_test");

    const startEveSession = await importStartEveSession();

    await expect(
      startEveSession({
        agent: "retention-strategist",
        userId: "user-123",
        callbackEvent: "agent.completed",
      }),
    ).rejects.toThrow("EVE_BASE_URL is not set");
  });

  it("throws when EVE_TOKEN is not set", async () => {
    vi.stubEnv("EVE_BASE_URL", "https://eve.example.com");
    vi.stubEnv("EVE_TOKEN", "");

    const startEveSession = await importStartEveSession();

    await expect(
      startEveSession({
        agent: "retention-strategist",
        userId: "user-123",
        callbackEvent: "agent.completed",
      }),
    ).rejects.toThrow("EVE_TOKEN is not set");
  });

  it("POSTs to EVE_BASE_URL/eve/v1/session with the correct shape", async () => {
    vi.stubEnv("EVE_BASE_URL", "https://eve.example.com");
    vi.stubEnv("EVE_TOKEN", "tok_test");

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ sessionId: "ses_mock_123" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const startEveSession = await importStartEveSession();
    const result = await startEveSession({
      agent: "retention-strategist",
      userId: "user-abc",
      callbackEvent: "agent.completed",
      input: { email: "ada@example.com" },
    });

    expect(result.sessionId).toBe("ses_mock_123");

    // Assert the outbound fetch shape.
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://eve.example.com/eve/v1/session");
    expect(init.method).toBe("POST");

    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer tok_test");
    expect(headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(init.body as string) as {
      agent: string;
      input: Record<string, unknown>;
      metadata: { userId: string; callbackEvent: string };
    };
    expect(body.agent).toBe("retention-strategist");
    expect(body.metadata.userId).toBe("user-abc");
    expect(body.metadata.callbackEvent).toBe("agent.completed");
    expect(body.input).toEqual({ email: "ada@example.com" });
  });

  it("falls back to 'id' field when sessionId is absent in the response", async () => {
    vi.stubEnv("EVE_BASE_URL", "https://eve.example.com");
    vi.stubEnv("EVE_TOKEN", "tok_test");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ id: "ses_via_id" }),
      }),
    );

    const startEveSession = await importStartEveSession();
    const result = await startEveSession({
      agent: "retention-strategist",
      userId: "u1",
      callbackEvent: "agent.completed",
    });
    expect(result.sessionId).toBe("ses_via_id");
  });

  it("throws on a non-ok HTTP response", async () => {
    vi.stubEnv("EVE_BASE_URL", "https://eve.example.com");
    vi.stubEnv("EVE_TOKEN", "tok_test");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        text: async () => "Eve is down",
      }),
    );

    const startEveSession = await importStartEveSession();
    await expect(
      startEveSession({
        agent: "retention-strategist",
        userId: "u1",
        callbackEvent: "agent.completed",
      }),
    ).rejects.toThrow(/Eve session start failed: 500/);
  });

  it("throws when the response carries no sessionId or id", async () => {
    vi.stubEnv("EVE_BASE_URL", "https://eve.example.com");
    vi.stubEnv("EVE_TOKEN", "tok_test");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ status: "created" }), // no sessionId
      }),
    );

    const startEveSession = await importStartEveSession();
    await expect(
      startEveSession({
        agent: "retention-strategist",
        userId: "u1",
        callbackEvent: "agent.completed",
      }),
    ).rejects.toThrow("Eve session response did not include a sessionId");
  });
});
