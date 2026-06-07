import type { HogsendClient } from "@hogsend/engine";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { contacts, journeyStates, userEvents } = await import("@hogsend/db");
const { and, eq } = await import("drizzle-orm");
const { createApp, createHogsendClient } = await import("@hogsend/engine");
const { journeys } = await import("../journeys/index.js");

// Hatchet injected via the container override seam so the ingest pipeline's
// `hatchet.events.push` lands on a spy. The push payload is how a journey is
// routed (Hatchet matches `onEvents` on the event name), so asserting the push
// proves the event would fire the matching journey.
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
  overrides: { hatchet: mockHatchet },
});
const app = createApp(container);
const { db } = container;

const AUTH_HEADER = {
  Authorization: `Bearer ${process.env.ADMIN_API_KEY}`,
  "Content-Type": "application/json",
};

const RUN = `edp-${Date.now()}`;
const SPLIT_USER = `${RUN}-split`;
const SPLIT_EMAIL = `${RUN}-split@example.com`;
const IDEM_USER = `${RUN}-idem`;
const JOURNEY_USER = `${RUN}-journey`;

beforeEach(() => {
  pushSpy.mockClear();
});

afterAll(async () => {
  for (const userId of [SPLIT_USER, IDEM_USER, JOURNEY_USER]) {
    await db.delete(userEvents).where(eq(userEvents.userId, userId));
    await db.delete(journeyStates).where(eq(journeyStates.userId, userId));
    await db.delete(contacts).where(eq(contacts.externalId, userId));
  }
});

describe("POST /v1/events — property split (D2)", () => {
  it("stores eventProperties on user_events but NOT on the contact; merges contactProperties onto the contact", async () => {
    const res = await app.request("/v1/events", {
      method: "POST",
      headers: AUTH_HEADER,
      body: JSON.stringify({
        name: "split.test",
        userId: SPLIT_USER,
        email: SPLIT_EMAIL,
        eventProperties: { clickId: "evt-123", page: "/pricing" },
        contactProperties: { plan: "pro", company: "Acme" },
      }),
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.stored).toBe(true);
    expect(body.exits).toBeInstanceOf(Array);

    // The user_events row carries ONLY the eventProperties bag.
    const [evt] = await db
      .select()
      .from(userEvents)
      .where(
        and(
          eq(userEvents.userId, SPLIT_USER),
          eq(userEvents.event, "split.test"),
        ),
      );
    expect(evt).toBeDefined();
    const evtProps = evt?.properties as Record<string, unknown>;
    expect(evtProps?.clickId).toBe("evt-123");
    expect(evtProps?.page).toBe("/pricing");
    // The event prop bag must NOT have leaked the contact properties.
    expect(evtProps?.plan).toBeUndefined();
    expect(evtProps?.company).toBeUndefined();

    // The contact carries ONLY the contactProperties bag (the eventProperties
    // never touch contacts.properties — the D2 split).
    const [contact] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.externalId, SPLIT_USER));
    const contactProps = contact?.properties as Record<string, unknown>;
    expect(contactProps?.plan).toBe("pro");
    expect(contactProps?.company).toBe("Acme");
    expect(contactProps?.clickId).toBeUndefined();
    expect(contactProps?.page).toBeUndefined();
  });

  it("returns 400 when neither email nor userId is supplied", async () => {
    const res = await app.request("/v1/events", {
      method: "POST",
      headers: AUTH_HEADER,
      body: JSON.stringify({ name: "no.identity", eventProperties: {} }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /v1/events — idempotency", () => {
  it("dedupes on the Idempotency-Key header (second call stores nothing)", async () => {
    const key = `${RUN}-idem-key-1`;

    const first = await app.request("/v1/events", {
      method: "POST",
      headers: { ...AUTH_HEADER, "Idempotency-Key": key },
      body: JSON.stringify({
        name: "idem.test",
        userId: IDEM_USER,
        eventProperties: { n: 1 },
      }),
    });
    expect(first.status).toBe(202);
    expect((await first.json()).stored).toBe(true);

    const second = await app.request("/v1/events", {
      method: "POST",
      headers: { ...AUTH_HEADER, "Idempotency-Key": key },
      body: JSON.stringify({
        name: "idem.test",
        userId: IDEM_USER,
        eventProperties: { n: 2 },
      }),
    });
    expect(second.status).toBe(202);
    expect((await second.json()).stored).toBe(false);

    // Exactly one user_events row survived for that key.
    const rows = await db
      .select()
      .from(userEvents)
      .where(
        and(
          eq(userEvents.userId, IDEM_USER),
          eq(userEvents.event, "idem.test"),
        ),
      );
    expect(rows).toHaveLength(1);
  });
});

describe("POST /v1/events — journey routing on an eventProperty", () => {
  it("pushes the trigger event with the eventProperty so a journey's trigger.where can match", async () => {
    // `test-onboarding` triggers on `test.signup`. We carry an event property
    // (`plan`) that a journey trigger.where could gate on — the routed Hatchet
    // push must carry the event name + the eventProperty in its `properties`
    // bag (the wire key stays `properties`).
    const res = await app.request("/v1/events", {
      method: "POST",
      headers: AUTH_HEADER,
      body: JSON.stringify({
        name: "test.signup",
        userId: JOURNEY_USER,
        eventProperties: { plan: "pro", source: "events-dataplane" },
      }),
    });
    expect(res.status).toBe(202);

    const triggerPush = pushSpy.mock.calls.find(
      (call) => call[0] === "test.signup",
    );
    expect(triggerPush).toBeDefined();
    const payload = triggerPush?.[1] as {
      userId?: string;
      properties?: Record<string, unknown>;
    };
    expect(payload?.userId).toBe(JOURNEY_USER);
    // The eventProperty reaches the journey-routing payload (this is what the
    // journey's trigger.where evaluates against).
    expect(payload?.properties?.plan).toBe("pro");
    expect(payload?.properties?.source).toBe("events-dataplane");
  });
});
