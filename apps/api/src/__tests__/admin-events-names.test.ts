/**
 * GET /v1/admin/events/names — the merged observed+declared event-name
 * vocabulary (Phase 1 of the @hogsend/mcp plan: the catalog scope's HTTP
 * backing, ported from the blueprint tools' `list_events`). Proves: the
 * open-vocabulary note, observed events with occurrence counts +
 * recency, declared-but-never-fired blueprint/journey triggers with
 * usedBy labels, literal matching of ilike special characters in
 * `search`, the limit bounds, and the admin auth gate. Also proves the
 * literal "names" path is not captured by the /{id} param route.
 */
import type { HogsendClient } from "@hogsend/engine";
import { afterAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { journeyBlueprints, userEvents } = await import("@hogsend/db");
const { eq, like } = await import("drizzle-orm");
const { createApp, createHogsendClient } = await import("@hogsend/engine");
const { journeys } = await import("../journeys/index.js");
const { conversions } = await import("../conversions/index.js");
const { templates } = await import("../emails/index.js");
const { lists } = await import("../lists/index.js");

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
  journeys,
  conversions,
  lists,
  email: { templates },
  overrides: { hatchet: mockHatchet },
});
const app = createApp(container);
const { db } = container;

const AUTH_HEADER = { Authorization: `Bearer ${process.env.ADMIN_API_KEY}` };

// Run-scoped prefix so parallel test files against the shared docker DB
// never collide; everything created here is swept in afterAll.
const RUN = `aen-${Date.now()}`;
const EVENTS_USER = `${RUN}-user`;

type EventNameEntry = {
  name: string;
  occurrences: number;
  lastSeenAt: string | null;
  usedBy: string[];
};

afterAll(async () => {
  await db.delete(userEvents).where(eq(userEvents.userId, EVENTS_USER));
  await db
    .delete(journeyBlueprints)
    .where(like(journeyBlueprints.id, `${RUN}%`));
});

async function fetchNames(query: string): Promise<EventNameEntry[]> {
  const res = await app.request(`/v1/admin/events/names?${query}`, {
    headers: AUTH_HEADER,
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  return body.events as EventNameEntry[];
}

describe("GET /v1/admin/events/names", () => {
  it("rejects an unauthenticated request", async () => {
    const res = await app.request("/v1/admin/events/names");
    expect(res.status).toBe(401);
  });

  it("merges observed events with blueprint trigger declarations, honestly labeled", async () => {
    await db.insert(userEvents).values([
      { userId: EVENTS_USER, event: `${RUN}.observed`, source: "test" },
      { userId: EVENTS_USER, event: `${RUN}.observed`, source: "test" },
    ]);
    await db.insert(journeyBlueprints).values({
      id: `${RUN}-bp`,
      name: "Names test blueprint",
      status: "draft",
      triggerEvent: `${RUN}.declared`,
      entryLimit: "once",
      suppress: {},
      graph: { journeyId: `${RUN}-bp`, nodes: [], edges: [] },
      source: "api",
    });

    const res = await app.request(
      `/v1/admin/events/names?search=${encodeURIComponent(RUN)}`,
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.note).toContain("open vocabulary");

    const events = body.events as EventNameEntry[];
    const observed = events.find((e) => e.name === `${RUN}.observed`);
    expect(observed).toMatchObject({ occurrences: 2, usedBy: [] });
    expect(observed?.lastSeenAt).toBeTruthy();

    // Declared-but-never-fired blueprint trigger still shows up, labeled.
    const declared = events.find((e) => e.name === `${RUN}.declared`);
    expect(declared).toMatchObject({ occurrences: 0, lastSeenAt: null });
    expect(declared?.usedBy).toContain(`blueprint:${RUN}-bp (draft)`);
  });

  it("labels code-journey triggers", async () => {
    const events = await fetchNames("search=user.created");
    const entry = events.find((e) => e.name === "user.created");
    expect(entry?.usedBy).toContain("journey:activation-welcome");
  });

  it("escapes ilike special characters so a search of '100%' matches literally", async () => {
    await db.insert(userEvents).values([
      { userId: EVENTS_USER, event: `${RUN}.100%done`, source: "test" },
      // Would match an UNescaped `%100%%` pattern (% as wildcard) but must
      // not match the literal search.
      { userId: EVENTS_USER, event: `${RUN}.100xdone`, source: "test" },
    ]);

    const events = await fetchNames(
      `search=${encodeURIComponent(`${RUN}.100%`)}`,
    );
    expect(events.map((e) => e.name)).toEqual([`${RUN}.100%done`]);
  });

  it("caps the observed scan via limit (recency-first)", async () => {
    await db.insert(userEvents).values([
      {
        userId: EVENTS_USER,
        event: `${RUN}.older`,
        source: "test",
        occurredAt: new Date(Date.now() - 60_000),
      },
      { userId: EVENTS_USER, event: `${RUN}.newer`, source: "test" },
    ]);

    const events = await fetchNames(
      `search=${encodeURIComponent(`${RUN}.`)}&limit=1`,
    );
    const observedNames = events
      .filter((e) => e.occurrences > 0)
      .map((e) => e.name);
    expect(observedNames).toEqual([`${RUN}.newer`]);
  });

  it("backfills true occurrences for a declared trigger truncated out of the limited observed scan", async () => {
    // Two observed events under a distinct sub-prefix. The declared one is
    // older, so a limit=1 recency-first observed scan returns ONLY the decoy —
    // truncating the declared trigger out of the observed rows. Without the
    // targeted backfill it would misreport occurrences:0 / lastSeenAt:null;
    // with it, the declared trigger keeps its real count + recency.
    const decoy = `${RUN}.bf-decoy`;
    const declared = `${RUN}.bf-declared`;
    await db.insert(userEvents).values([
      {
        userId: EVENTS_USER,
        event: declared,
        source: "test",
        occurredAt: new Date(Date.now() - 60_000),
      },
      {
        userId: EVENTS_USER,
        event: declared,
        source: "test",
        occurredAt: new Date(Date.now() - 60_000),
      },
      { userId: EVENTS_USER, event: decoy, source: "test" },
    ]);
    await db.insert(journeyBlueprints).values({
      id: `${RUN}-bf-bp`,
      name: "Backfill test blueprint",
      status: "enabled",
      triggerEvent: declared,
      entryLimit: "once",
      suppress: {},
      graph: { journeyId: `${RUN}-bf-bp`, nodes: [], edges: [] },
      source: "api",
    });

    const events = await fetchNames(
      `search=${encodeURIComponent(`${RUN}.bf`)}&limit=1`,
    );

    const entry = events.find((e) => e.name === declared);
    expect(entry).toBeDefined();
    expect(entry?.occurrences).toBe(2);
    expect(entry?.lastSeenAt).toBeTruthy();
    expect(entry?.usedBy).toContain(`blueprint:${RUN}-bf-bp (enabled)`);
  });

  it("rejects an out-of-range limit", async () => {
    const low = await app.request("/v1/admin/events/names?limit=0", {
      headers: AUTH_HEADER,
    });
    expect(low.status).toBe(400);

    const high = await app.request("/v1/admin/events/names?limit=201", {
      headers: AUTH_HEADER,
    });
    expect(high.status).toBe(400);
  });

  it("is not captured by the /{id} param route", async () => {
    // /{id} validates a uuid param — reaching it with "names" would 400;
    // the names route returning 200 proves the registration order.
    const res = await app.request("/v1/admin/events/names", {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
  });
});
