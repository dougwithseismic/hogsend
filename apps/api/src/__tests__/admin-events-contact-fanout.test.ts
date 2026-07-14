import type { HogsendClient } from "@hogsend/engine";
import { afterAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { contacts, userEvents } = await import("@hogsend/db");
const { eq, inArray } = await import("drizzle-orm");
const { createApp, createHogsendClient } = await import("@hogsend/engine");

// Admin list/get routes never touch Hatchet; the mock only keeps the
// container from dialing a real engine at construction time.
const mockHatchet = {
  durableTask: vi.fn(() => ({
    run: vi.fn(),
    runNoWait: vi.fn(),
    runAndWait: vi.fn(),
  })),
  task: vi.fn(() => ({ run: vi.fn(), runNoWait: vi.fn() })),
  events: { push: vi.fn() },
  runs: { cancel: vi.fn(), get: vi.fn() },
  worker: vi.fn(),
} as unknown as HogsendClient["hatchet"];

const container = createHogsendClient({
  overrides: { hatchet: mockHatchet },
});
const app = createApp(container);
const { db } = container;

const AUTH_HEADER = {
  Authorization: `Bearer ${process.env.ADMIN_API_KEY}`,
};

const RUN = `aecf-${Date.now()}`;
// One string living in TWO identity namespaces: the real contact's
// external_id AND a phantom contact's anonymous_id. This is the prod shape a
// mis-keyed emitter creates (an identified session's distinct_id — the
// contact key — sent as an ingest `anonymousId`).
const KEY = `${RUN}-collision-key`;
const EMAIL = `${RUN}@example.com`;

afterAll(async () => {
  await db.delete(userEvents).where(eq(userEvents.userId, KEY));
  await db
    .delete(contacts)
    .where(inArray(contacts.anonymousId, [KEY, `${KEY}-real-anon`]));
});

describe("GET /v1/admin/events — cross-kind contact-key collision", () => {
  it("returns each event ONCE, resolved to the externalId-keyed contact", async () => {
    const [real] = await db
      .insert(contacts)
      .values({
        externalId: KEY,
        anonymousId: `${KEY}-real-anon`,
        email: EMAIL,
      })
      .returning({ id: contacts.id });
    const [phantom] = await db
      .insert(contacts)
      .values({ anonymousId: KEY })
      .returning({ id: contacts.id });
    if (!real || !phantom) throw new Error("contact seed failed");

    const [event] = await db
      .insert(userEvents)
      .values({ userId: KEY, event: `${RUN}.opened`, source: "test" })
      .returning({ id: userEvents.id });
    if (!event) throw new Error("event seed failed");

    const listRes = await app.request(
      `/v1/admin/events?userId=${encodeURIComponent(KEY)}`,
      { headers: AUTH_HEADER },
    );
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as {
      events: Array<{ id: string; contactId: string; userEmail: string }>;
      total: number;
    };

    // The bare OR-join fanned this out into one row per matching contact
    // (same event id twice — once per person). Exactly one row must survive,
    // and it must be the externalId match (ingest's resolution precedence),
    // never the phantom.
    expect(list.events).toHaveLength(1);
    expect(list.total).toBe(1);
    expect(list.events[0]?.id).toBe(event.id);
    expect(list.events[0]?.contactId).toBe(real.id);
    expect(list.events[0]?.userEmail).toBe(EMAIL);

    const getRes = await app.request(`/v1/admin/events/${event.id}`, {
      headers: AUTH_HEADER,
    });
    expect(getRes.status).toBe(200);
    const detail = (await getRes.json()) as {
      event: { contactId: string; userEmail: string };
    };
    expect(detail.event.contactId).toBe(real.id);
    expect(detail.event.userEmail).toBe(EMAIL);

    // Soft-delete the real contact: resolution falls through to the live
    // anonymousId match instead of surfacing a deleted contact.
    await db
      .update(contacts)
      .set({ deletedAt: new Date() })
      .where(eq(contacts.id, real.id));

    const fallbackRes = await app.request(
      `/v1/admin/events?userId=${encodeURIComponent(KEY)}`,
      { headers: AUTH_HEADER },
    );
    const fallback = (await fallbackRes.json()) as {
      events: Array<{ contactId: string | null; userEmail: string | null }>;
    };
    expect(fallback.events).toHaveLength(1);
    expect(fallback.events[0]?.contactId).toBe(phantom.id);
    expect(fallback.events[0]?.userEmail).toBeNull();
  });
});
