import type { HogsendClient } from "@hogsend/engine";
import { afterAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { contacts, journeyStates, userEvents } = await import("@hogsend/db");
const { eq } = await import("drizzle-orm");
const { createApp, createHogsendClient } = await import("@hogsend/engine");
const { journeys } = await import("../journeys/index.js");
const { conversions } = await import("../conversions/index.js");

/**
 * HOGSEND_INGEST_SUSPENDED — the Hogsend Cloud metering kill-switch.
 *
 * The flag is validated env, parsed once per process at first engine import,
 * so (like `openapi-prod.test.ts` does for NODE_ENV) we clone the container
 * with an overridden `env` rather than mutating the shared singleton. The
 * route reads `c.get("container").env`, so the clone is the real code path.
 */

const pushSpy = vi.fn();
const mockHatchet = {
  durableTask: vi.fn(() => ({
    run: vi.fn(),
    runNoWait: vi.fn(),
    runAndWait: vi.fn(),
  })),
  task: vi.fn(() => ({ run: vi.fn(), runNoWait: vi.fn() })),
  events: { push: pushSpy },
  runs: { cancel: vi.fn(), get: vi.fn() },
  worker: vi.fn(),
} as unknown as HogsendClient["hatchet"];

const container = createHogsendClient({
  journeys,
  conversions,
  overrides: { hatchet: mockHatchet },
});

function appWith(suspended: "true" | "false") {
  return createApp({
    ...container,
    env: {
      ...container.env,
      HOGSEND_INGEST_SUSPENDED: suspended,
    } as typeof container.env,
  });
}

const suspendedApp = appWith("true");
const liveApp = appWith("false");
// The default container env — the flag is unset in the vitest env, so this
// proves "absent ⇒ behavior unchanged" against the REAL parsed value.
const defaultApp = createApp(container);

const AUTH_HEADER = {
  Authorization: `Bearer ${process.env.ADMIN_API_KEY}`,
  "Content-Type": "application/json",
};

const RUN = `susp-${Date.now()}`;
const LIVE_USER = `${RUN}-live`;
const DEFAULT_USER = `${RUN}-default`;
const BLOCKED_USER = `${RUN}-blocked`;

// A syntactically valid but non-existent send id — the open pixel and click
// redirect resolve nothing and still answer normally.
const ORPHAN_SEND_ID = "00000000-0000-4000-8000-000000000000";

const { db } = container;

afterAll(async () => {
  for (const userId of [LIVE_USER, DEFAULT_USER, BLOCKED_USER]) {
    await db.delete(userEvents).where(eq(userEvents.userId, userId));
    await db.delete(journeyStates).where(eq(journeyStates.userId, userId));
    await db.delete(contacts).where(eq(contacts.externalId, userId));
  }
});

describe("HOGSEND_INGEST_SUSPENDED=true — POST /v1/events", () => {
  it("returns 429 with the documented body", async () => {
    pushSpy.mockClear();
    const res = await suspendedApp.request("/v1/events", {
      method: "POST",
      headers: AUTH_HEADER,
      body: JSON.stringify({
        name: "suspended.test",
        userId: BLOCKED_USER,
        email: `${BLOCKED_USER}@example.com`,
      }),
    });

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      error: "ingest_suspended",
      message:
        "Event ingest is suspended for this instance (plan limit reached or billing hold). Already-accepted events are unaffected.",
    });
  });

  it("writes nothing and pushes nothing (refused BEFORE the DB write / Hatchet push)", async () => {
    pushSpy.mockClear();
    await suspendedApp.request("/v1/events", {
      method: "POST",
      headers: AUTH_HEADER,
      body: JSON.stringify({
        name: "suspended.test",
        userId: BLOCKED_USER,
        email: `${BLOCKED_USER}@example.com`,
      }),
    });

    expect(pushSpy).not.toHaveBeenCalled();
    const rows = await db
      .select()
      .from(userEvents)
      .where(eq(userEvents.userId, BLOCKED_USER));
    expect(rows).toHaveLength(0);
    const contactRows = await db
      .select()
      .from(contacts)
      .where(eq(contacts.externalId, BLOCKED_USER));
    expect(contactRows).toHaveLength(0);
  });
});

describe("HOGSEND_INGEST_SUSPENDED=true — everything else is unaffected", () => {
  it("health still answers 200", async () => {
    const res = await suspendedApp.request("/v1/health");
    expect(res.status).toBe(200);
  });

  it("the open pixel still answers 200 with a GIF", async () => {
    const res = await suspendedApp.request(`/v1/t/o/${ORPHAN_SEND_ID}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/gif");
  });

  it("the click redirect behaves exactly as on a live instance", async () => {
    const suspendedRes = await suspendedApp.request(
      `/v1/t/c/${ORPHAN_SEND_ID}`,
      { redirect: "manual" },
    );
    const liveRes = await liveApp.request(`/v1/t/c/${ORPHAN_SEND_ID}`, {
      redirect: "manual",
    });
    expect(suspendedRes.status).not.toBe(429);
    expect(suspendedRes.status).toBe(liveRes.status);
  });

  it("the email-provider webhook behaves exactly as on a live instance", async () => {
    const body = JSON.stringify({ type: "email.delivered", data: {} });
    const headers = { "Content-Type": "application/json" };
    const suspendedRes = await suspendedApp.request(
      "/v1/webhooks/email/resend",
      { method: "POST", headers, body },
    );
    const liveRes = await liveApp.request("/v1/webhooks/email/resend", {
      method: "POST",
      headers,
      body,
    });
    expect(suspendedRes.status).not.toBe(429);
    expect(suspendedRes.status).toBe(liveRes.status);
  });

  it("the compliance surfaces (unsubscribe + preferences) behave as on a live instance", async () => {
    for (const path of [
      "/v1/email/unsubscribe?token=bogus",
      "/v1/email/preferences?token=bogus",
    ]) {
      const suspendedRes = await suspendedApp.request(path);
      const liveRes = await liveApp.request(path);
      expect(suspendedRes.status).not.toBe(429);
      expect(suspendedRes.status).toBe(liveRes.status);
    }
  });
});

describe("HOGSEND_INGEST_SUSPENDED off/absent — ingest is normal", () => {
  it('accepts events with the flag explicitly "false"', async () => {
    pushSpy.mockClear();
    const res = await liveApp.request("/v1/events", {
      method: "POST",
      headers: AUTH_HEADER,
      body: JSON.stringify({
        name: "suspended.test",
        userId: LIVE_USER,
        email: `${LIVE_USER}@example.com`,
      }),
    });

    expect(res.status).toBe(202);
    expect((await res.json()).stored).toBe(true);
    expect(pushSpy).toHaveBeenCalled();
  });

  it("accepts events with the flag unset (default container env)", async () => {
    pushSpy.mockClear();
    const res = await defaultApp.request("/v1/events", {
      method: "POST",
      headers: AUTH_HEADER,
      body: JSON.stringify({
        name: "suspended.test",
        userId: DEFAULT_USER,
        email: `${DEFAULT_USER}@example.com`,
      }),
    });

    expect(res.status).toBe(202);
    expect((await res.json()).stored).toBe(true);
    expect(pushSpy).toHaveBeenCalled();
  });
});
