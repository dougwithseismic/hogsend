/**
 * PRD 05 T7 — the admin + agent read surfaces read history by SUBJECT.
 *
 * Every case here uses a DIVERGENT key: history stamped under a key the
 * contact has since moved off (an anonymous id from before they registered),
 * read back under the contact's CURRENT canonical key. That is the only shape
 * where the two arms of `bySubject` disagree — a same-key fixture passes
 * identically before and after the flip and certifies nothing.
 *
 *   (a) timeline — all three legs (events, journey states, journey-attached
 *       sends) must surface the stale-key history for a resolved contact.
 *
 *   (b) GET /v1/admin/events?userId= — the operator-typed text key resolves to
 *       its contact, so the filter returns that person's WHOLE history.
 *
 *   (c) GET /v1/admin/journeys/:id/states?userId= — same, for enrollments.
 *
 *   (d) GET /v1/admin/impact/overview — the lift/holdout CTE. This is the one
 *       that fails SILENTLY: the old `c.user_key = js.user_id` string join
 *       missed every conversion recorded under a key the person moved off
 *       AFTER enrolling, so a real converter read as a non-converter and the
 *       journey looked like it did nothing. The assertion is deliberately on
 *       a NON-ZERO converter count — a zero-row assertion passes on a broken
 *       query, which is the whole trap this batch had to avoid.
 *
 *   (e) the userKey ELSE-arm — a contactless subject (the engine refuses to
 *       mint a contact on observation) must still be reachable by the string
 *       key. A naive `eq(contact_id, …)` flip strands that population.
 *
 * Fixture law (inherited from journey-flip-reads.test.ts): every identity
 * value is run-namespaced, no assertion counts rows outside this run's
 * namespace, and the divergent-key history is created by stamping
 * `contact_id` with the raw adoption UPDATE
 * (`SET contact_id = :id WHERE user_id = :staleKey AND contact_id IS NULL`)
 * rather than via `resolveOrCreateContact` — adoption today ALSO rewrites
 * `user_id` onto the new canonical key, which would leave the rows reachable
 * by string and make the flip unobservable.
 */
import { randomUUID } from "node:crypto";
import type { HogsendClient } from "@hogsend/engine";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { contacts, conversions, emailSends, journeyStates, userEvents } =
  await import("@hogsend/db");
const { eq, inArray, sql } = await import("drizzle-orm");
const { createApp, createHogsendClient, defineJourney } = await import(
  "@hogsend/engine"
);

// Admin read routes never touch Hatchet; the mock only keeps the container
// from dialing a real engine at construction time.
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

const RUN = `t7flip-${randomUUID()}`;
const uid = (label: string) => `${RUN}-${label}`;

// The identified subject: history under STALE, contact keyed by CURRENT.
const STALE = uid("stale-anon");
const CURRENT = uid("current-user");
const EMAIL = `${uid("subject")}@example.test`;
const JOURNEY = uid("journey");

// The contactless subject — the `bySubject` else-arm.
const ORPHAN = uid("orphan-anon");

const impactJourney = defineJourney({
  meta: {
    id: JOURNEY,
    name: "T7 flip reads",
    enabled: true,
    trigger: { event: `${RUN}.enroll` },
    entryLimit: "once",
    suppress: { hours: 0 },
  },
  run: async () => {},
});

const container = createHogsendClient({
  journeys: [impactJourney],
  overrides: { hatchet: mockHatchet },
});
const app = createApp(container);
const { db } = container;

const AUTH_HEADER = { Authorization: `Bearer ${process.env.ADMIN_API_KEY}` };

let contactId = "";
let staleStateId = "";

const DAY = 24 * 60 * 60 * 1000;
const ENROLLED_AT = new Date(Date.now() - 10 * DAY);
const CONVERTED_AT = new Date(Date.now() - 9 * DAY);

beforeAll(async () => {
  // (1) The anonymous era. History lands under STALE with no owner, because
  // the engine refuses to mint a contact on observation.
  await db.insert(userEvents).values({
    userId: STALE,
    event: `${RUN}.viewed`,
    properties: {},
    source: "test",
    occurredAt: ENROLLED_AT,
  });
  const [state] = await db
    .insert(journeyStates)
    .values({
      userId: STALE,
      userEmail: EMAIL,
      journeyId: JOURNEY,
      currentNodeId: "entry",
      status: "completed",
      createdAt: ENROLLED_AT,
    })
    .returning({ id: journeyStates.id });
  if (!state) throw new Error("state seed failed");
  staleStateId = state.id;
  await db.insert(emailSends).values({
    journeyStateId: state.id,
    userId: STALE,
    templateKey: `${RUN}-welcome`,
    fromEmail: "test@example.test",
    toEmail: EMAIL,
    subject: "T7 welcome",
    status: "sent",
  });

  // (2) Registration. The contact's canonical key is CURRENT — the stale
  // history keeps its old `user_id` string forever.
  const [contact] = await db
    .insert(contacts)
    .values({ externalId: CURRENT, anonymousId: STALE, email: EMAIL })
    .returning({ id: contacts.id });
  if (!contact) throw new Error("contact seed failed");
  contactId = contact.id;

  // (3) Adoption, PRD 05 D4's statement verbatim — stamp the owner WITHOUT
  // rewriting `user_id`. This is the shape T9 makes permanent.
  for (const table of ["user_events", "journey_states", "email_sends"]) {
    await db.execute(
      sql`update ${sql.identifier(table)} set contact_id = ${contactId}
          where user_id = ${STALE} and contact_id is null`,
    );
  }

  // (4) The conversion is recorded under the CURRENT key, as it would be
  // post-registration. The old `c.user_key = js.user_id` join compared
  // CURRENT to STALE and found nothing.
  const [convEvent] = await db
    .insert(userEvents)
    .values({
      userId: CURRENT,
      contactId,
      event: `${RUN}.sold`,
      properties: {},
      source: "test",
      occurredAt: CONVERTED_AT,
    })
    .returning({ id: userEvents.id });
  if (!convEvent) throw new Error("conversion event seed failed");
  await db.insert(conversions).values({
    definitionId: `${RUN}-sale`,
    contactId,
    userKey: CURRENT,
    eventId: convEvent.id,
    occurredAt: CONVERTED_AT,
  });

  // (5) The contactless subject: an enrollment nobody owns.
  await db.insert(journeyStates).values({
    userId: ORPHAN,
    userEmail: "",
    journeyId: JOURNEY,
    currentNodeId: "entry",
    status: "completed",
    createdAt: ENROLLED_AT,
  });
});

afterAll(async () => {
  await db.delete(emailSends).where(inArray(emailSends.userId, [STALE]));
  await db.delete(journeyStates).where(eq(journeyStates.journeyId, JOURNEY));
  await db
    .delete(userEvents)
    .where(inArray(userEvents.userId, [STALE, CURRENT, ORPHAN]));
  if (contactId) {
    await db.delete(contacts).where(eq(contacts.id, contactId));
  }
});

describe("T7 (a) — the contact timeline follows the subject, not the string", () => {
  it("surfaces stale-key events, enrollments and sends for the resolved contact", async () => {
    const res = await app.request(
      `/v1/admin/contacts/${contactId}/timeline?limit=100`,
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      timeline: Array<{ type: string; data: Record<string, unknown> }>;
      total: number;
    };

    const byType = (t: string) => body.timeline.filter((e) => e.type === t);
    // Non-zero on every leg: the whole point is that these are NOT empty.
    // Pre-flip each read matched `user_id = CURRENT` and returned nothing,
    // which rendered as an empty timeline rather than as an error.
    expect(byType("event").length).toBeGreaterThan(0);
    expect(byType("journey")).toHaveLength(1);
    expect(byType("email")).toHaveLength(1);
    expect(byType("journey")[0]?.data.journeyId).toBe(JOURNEY);
    expect(byType("email")[0]?.data.templateKey).toBe(`${RUN}-welcome`);
    expect(body.total).toBe(byType("event").length + 2);
  });
});

describe("T7 (b) — GET /v1/admin/events?userId= resolves the key to its contact", () => {
  it("returns history stamped under the stale key when filtered by the current one", async () => {
    const res = await app.request(
      `/v1/admin/events?userId=${encodeURIComponent(CURRENT)}&limit=100`,
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: Array<{ event: string; userId: string; contactId: string }>;
      total: number;
    };

    // BOTH events: the anon-era one (user_id = STALE) and the post-
    // registration one. The string filter would have returned only the
    // latter — a silent halving of the person's history.
    const names = body.events.map((e) => e.event).sort();
    expect(names).toEqual([`${RUN}.sold`, `${RUN}.viewed`]);
    expect(body.total).toBe(2);
    // Both rows resolve to the one owner via the contact_id FK.
    expect(new Set(body.events.map((e) => e.contactId))).toEqual(
      new Set([contactId]),
    );
  });

  it("falls back to the literal string for a key no contact owns", async () => {
    const res = await app.request(
      `/v1/admin/events?userId=${encodeURIComponent(ORPHAN)}&limit=100`,
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: number };
    // ORPHAN has an enrollment but no events; the point is that the request
    // resolves through the else-arm rather than erroring or matching the
    // identified subject's rows.
    expect(body.total).toBe(0);
  });
});

describe("T7 (c) — GET /v1/admin/journeys/:id/states?userId=", () => {
  it("finds the enrollment stamped under the stale key", async () => {
    const res = await app.request(
      `/v1/admin/journeys/${JOURNEY}/states?userId=${encodeURIComponent(CURRENT)}`,
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      states: Array<{ id: string; userId: string }>;
      total: number;
    };
    expect(body.total).toBe(1);
    expect(body.states[0]?.id).toBe(staleStateId);
  });

  it("still finds a contactless enrollment by its string key (bySubject else-arm)", async () => {
    const res = await app.request(
      `/v1/admin/journeys/${JOURNEY}/states?userId=${encodeURIComponent(ORPHAN)}`,
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      states: Array<{ userId: string }>;
      total: number;
    };
    expect(body.total).toBe(1);
    expect(body.states[0]?.userId).toBe(ORPHAN);
  });
});

describe("T7 (d) — the impact lift/holdout CTE counts the converter", () => {
  it("credits a conversion recorded under the CURRENT key to an enrollment stamped under the STALE one", async () => {
    const res = await app.request("/v1/admin/impact/overview?days=90", {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      journeys: Array<{
        journeyId: string;
        observational: { enrollments: number; converters: number };
      }>;
    };

    const row = body.journeys.find((j) => j.journeyId === JOURNEY);
    expect(row).toBeDefined();
    // Two enrollments — the identified subject AND the contactless orphan.
    // The orphan is the reason the count expression coalesces: a bare
    // `count(distinct js.contact_id)` drops NULLs and would report 1.
    expect(row?.observational.enrollments).toBe(2);
    // NON-ZERO on purpose. A zero-row assertion here passes on a query that
    // returns nothing, which is exactly how a bad raw-SQL flip hides.
    expect(row?.observational.converters).toBe(1);
  });
});

// LAST in the file on purpose: replay re-ingests, which writes fresh
// `user_events` rows under these keys and would perturb the counts the cases
// above assert. The assertion here is on the MATCH count, which is what the
// flipped predicate governs.
describe("T7 (f) — POST /v1/admin/events/replay selects by subject", () => {
  it("replays the stale-key event too when filtered by the current key", async () => {
    const res = await app.request("/v1/admin/events/replay", {
      method: "POST",
      headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
      body: JSON.stringify({ filter: { userId: CURRENT }, limit: 100 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { replayed: number; errors: number };
    // Both this person's events — the anon-era one stamped under STALE and
    // the post-registration one. The string filter matched only the latter,
    // so a replay silently skipped half the history it was asked to re-run.
    expect(body.replayed).toBe(2);
    expect(body.errors).toBe(0);
  });
});
