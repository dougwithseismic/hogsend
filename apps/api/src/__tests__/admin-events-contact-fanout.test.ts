import type { HogsendClient } from "@hogsend/engine";
import { afterAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
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
  it("returns each event ONCE, resolved by the contact_id FK, never fanned out", async () => {
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

    // The event names its owner via the FK the engine dual-writes. The
    // phantom still holds KEY in its `anonymous_id`, so the old three-way
    // key guess would have had TWO candidates for this one row.
    const [event] = await db
      .insert(userEvents)
      .values({
        userId: KEY,
        contactId: real.id,
        event: `${RUN}.opened`,
        source: "test",
      })
      .returning({ id: userEvents.id });
    if (!event) throw new Error("event seed failed");

    const getRes = await app.request(`/v1/admin/events/${event.id}`, {
      headers: AUTH_HEADER,
    });
    expect(getRes.status).toBe(200);
    const detail = (await getRes.json()) as {
      event: { id: string; contactId: string | null; userEmail: string | null };
    };
    // PRD 05 T7: the LATERAL that OR-matched user_id against external_id /
    // anonymous_id / id::text under a priority `case` is DELETED — the FK
    // names the owner, so the collision cannot produce a second candidate.
    expect(detail.event.id).toBe(event.id);
    expect(detail.event.contactId).toBe(real.id);
    expect(detail.event.userEmail).toBe(EMAIL);

    // Soft-delete the owner. The join keeps `deleted_at IS NULL` inside its
    // condition, so the event survives with NO contact rather than surfacing
    // a tombstone — and, unlike the old lateral, it does NOT fall through to
    // the phantom that merely happens to share the key string.
    await db
      .update(contacts)
      .set({ deletedAt: new Date() })
      .where(eq(contacts.id, real.id));

    const afterRes = await app.request(`/v1/admin/events/${event.id}`, {
      headers: AUTH_HEADER,
    });
    expect(afterRes.status).toBe(200);
    const after = (await afterRes.json()) as {
      event: { id: string; contactId: string | null; userEmail: string | null };
    };
    expect(after.event.id).toBe(event.id);
    expect(after.event.contactId).toBeNull();
    expect(after.event.userEmail).toBeNull();
  });
});
