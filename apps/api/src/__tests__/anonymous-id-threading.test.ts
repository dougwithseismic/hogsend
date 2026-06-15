import type { AnalyticsProvider, HogsendClient } from "@hogsend/engine";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { contacts, userEvents } = await import("@hogsend/db");
const { eq, inArray } = await import("drizzle-orm");
const { createApp, createHogsendClient } = await import("@hogsend/engine");

// Hatchet via the override seam — the ingest pipeline's downstream
// `hatchet.events.push` lands on a spy instead of a live engine. The resolve
// (where `anonymousId` becomes the canonical key) runs synchronously before any
// push, so the spy is irrelevant to the assertions but keeps the route off the
// network.
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

// A spy analytics provider with `identityMerge: true`, injected via the public
// `analytics: provider` arm (`isAnalyticsProvider` → bare provider branch). The
// vitest env sets NO `POSTHOG_API_KEY`, so no real provider auto-mounts and this
// spy IS the resolved active provider — `container.analytics === spy` (MF-9: no
// real PostHog provider wins resolution and silently swallows the calls). The
// engine fires `mergeIdentities` ONLY at a collide-MERGE / canonical-key flip;
// the whole point of `anonymousId` threading is that the contact's canonical key
// EQUALS the browser anon id at first sight, so a pure-threading event folds two
// keys into ZERO — this spy proves the merge wire is never touched.
const mergeSpy = vi.fn();
const captureSpy = vi.fn();
const setPersonPropertiesSpy = vi.fn(async () => {});

const analyticsSpy: AnalyticsProvider = {
  meta: { id: "spy", name: "Spy analytics" },
  capabilities: {
    personReads: false,
    personWrites: true,
    identityMerge: true,
  },
  getPersonProperties: async () => ({}),
  setPersonProperties: setPersonPropertiesSpy,
  mergeIdentities: mergeSpy,
  capture: captureSpy,
};

const container = createHogsendClient({
  analytics: analyticsSpy,
  overrides: { hatchet: mockHatchet },
});
const app = createApp(container);
const { db } = container;

const AUTH_HEADER = {
  Authorization: `Bearer ${process.env.ADMIN_API_KEY}`,
  "Content-Type": "application/json",
};

const RUN = `anon-${Date.now()}`;

// ---- pure threading (email + anonymousId, no userId) ----
const T_EMAIL = `${RUN}-thread@example.com`;
const T_ANON = `${RUN}-web-anon-1`;

// ---- threading then later external_id attach (still no merge wire on insert) ----
const A_EMAIL = `${RUN}-attach@example.com`;
const A_ANON = `${RUN}-web-anon-2`;
const A_USER = `${RUN}-attach-user`;

// ---- anonymousId is an EXTRA, never a third identity arm ----
const ONLY_ANON = `${RUN}-web-anon-only`;

// ---- userId present → anonymousId does NOT become the canonical key ----
const U_USER = `${RUN}-with-user`;
const U_ANON = `${RUN}-web-anon-3`;

const createdContactIds: string[] = [];
const userKeys = [T_ANON, A_ANON, A_USER, U_USER, ONLY_ANON];

async function postEvent(body: Record<string, unknown>) {
  return app.request("/v1/events", {
    method: "POST",
    headers: AUTH_HEADER,
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mergeSpy.mockClear();
  captureSpy.mockClear();
  setPersonPropertiesSpy.mockClear();
});

afterAll(async () => {
  await db.delete(userEvents).where(inArray(userEvents.userId, userKeys));
  for (const email of [T_EMAIL, A_EMAIL]) {
    await db.delete(contacts).where(eq(contacts.email, email));
  }
  if (createdContactIds.length > 0) {
    await db.delete(contacts).where(inArray(contacts.id, createdContactIds));
  }
});

describe("POST /v1/events — anonymousId threading (the zero-merge path)", () => {
  it("makes the contact's canonical key EQUAL the threaded anonymousId, with NO merge call", async () => {
    const res = await postEvent({
      name: `${RUN}.pageview`,
      email: T_EMAIL,
      anonymousId: T_ANON,
      eventProperties: { path: "/pricing" },
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.stored).toBe(true);

    // §4: with no external_id attached, the resolver precedence
    // (external → email → anonymous → discord) makes the contact's canonical
    // key (`external_id ?? anonymous_id ?? id`) BECOME the threaded anon id —
    // so the browser's own anon events and the server's captures land on ONE
    // analytics person. The returned `contactKey` is exactly that anon id.
    expect(body.contactKey).toBe(T_ANON);

    // The contact row persists the anon id on its `anonymous_id` column, and
    // carries NO external_id — its key is the anon id by construction, not by
    // a later fold.
    const [contact] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.email, T_EMAIL));
    expect(contact).toBeDefined();
    if (!contact) throw new Error("threaded contact not created");
    createdContactIds.push(contact.id);
    expect(contact.anonymousId).toBe(T_ANON);
    expect(contact.externalId).toBeNull();

    // The whole point: aligning the keys avoids any stitch. The merge wire is
    // NEVER touched (zero `mergeIdentities` / `alias` calls) — there is nothing
    // to fold because the two ids were one from the first identifying event.
    expect(mergeSpy).not.toHaveBeenCalled();
  });

  it("the threaded anonymousId round-trips: a follow-up event keyed by it resolves the SAME contact (still zero merge)", async () => {
    // The contact already exists from the prior test (same anon id). A second
    // event carrying email + the same anon id is a fill-in-link onto the SAME
    // row — no new contact, no merge.
    const res = await postEvent({
      name: `${RUN}.pageview2`,
      email: T_EMAIL,
      anonymousId: T_ANON,
      eventProperties: {},
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.contactKey).toBe(T_ANON);

    // Exactly one contact owns this email — the anon id never minted a twin.
    const rows = await db
      .select()
      .from(contacts)
      .where(eq(contacts.email, T_EMAIL));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.anonymousId).toBe(T_ANON);

    expect(mergeSpy).not.toHaveBeenCalled();
  });
});

describe("POST /v1/events — anonymousId is an EXTRA, never a third identity arm", () => {
  it("rejects an anonymousId-only event with 400 (requireIdentity still demands email or userId)", async () => {
    const res = await postEvent({
      name: `${RUN}.anon-only`,
      anonymousId: ONLY_ANON,
      eventProperties: {},
    });
    // anon-only public ingest is an abuse vector — `requireIdentity` enforces
    // email/userId BEFORE the resolver ever sees `anonymousId`.
    expect(res.status).toBe(400);

    // Nothing resolved, so nothing was created under the anon id, and the merge
    // wire never fired.
    const rows = await db
      .select()
      .from(contacts)
      .where(eq(contacts.anonymousId, ONLY_ANON));
    expect(rows).toHaveLength(0);
    expect(mergeSpy).not.toHaveBeenCalled();
  });
});

describe("POST /v1/events — anonymousId does NOT override a present userId", () => {
  it("keeps the canonical key as the external_id when a userId is supplied alongside anonymousId", async () => {
    const res = await postEvent({
      name: `${RUN}.identified-pageview`,
      userId: U_USER,
      anonymousId: U_ANON,
      eventProperties: {},
    });
    expect(res.status).toBe(202);
    const body = await res.json();

    // Resolver precedence is external → email → anonymous: a present external_id
    // (userId) WINS, so the canonical key is the userId, NOT the anon id — even
    // though the anon id is recorded on the row for future folds.
    expect(body.contactKey).toBe(U_USER);

    const [contact] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.externalId, U_USER));
    expect(contact).toBeDefined();
    if (!contact) throw new Error("identified contact not created");
    createdContactIds.push(contact.id);
    expect(contact.externalId).toBe(U_USER);
    expect(contact.anonymousId).toBe(U_ANON);

    // A single CREATE folds nothing — zero merge calls on the identified path
    // too (the anon id arrives attached to the new row, not folded into it).
    expect(mergeSpy).not.toHaveBeenCalled();
  });
});

describe("POST /v1/events — anonymousId threading then a later external_id attach (key flip)", () => {
  it("threads the anon id first with ZERO merge, then a later login flips the canonical key and fires exactly ONE anon-absorb merge in the survivor direction", async () => {
    // (1) First touch: email + anon id, no userId. Canonical key = the anon id;
    // no fold, so ZERO merge — this is the zero-merge threading invariant.
    const first = await postEvent({
      name: `${RUN}.subscribe`,
      email: A_EMAIL,
      anonymousId: A_ANON,
      eventProperties: {},
    });
    expect(first.status).toBe(202);
    const firstBody = await first.json();
    expect(firstBody.contactKey).toBe(A_ANON);
    expect(mergeSpy).not.toHaveBeenCalled();

    const [created] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.email, A_EMAIL));
    expect(created).toBeDefined();
    if (!created) throw new Error("threaded contact not created");
    createdContactIds.push(created.id);
    expect(created.anonymousId).toBe(A_ANON);
    expect(created.externalId).toBeNull();

    // Re-arm the spy: only the FLIP that follows should register a call.
    mergeSpy.mockClear();

    // (2) The SAME human later identifies with a real external_id. Email + anon
    // id both match the single existing row → fill-in-link attaches the
    // external_id. The canonical key FLIPS from the anon id to the external_id.
    // §5.3 emission point 2 (MF-3): the OLD key was the contact's OWN anon id
    // (NOT an external_id being superseded), so the flip is a LEGAL anon-absorb
    // — the resolver returns it as a safe `mergedKey` and the engine fires one
    // `mergeIdentities`.
    const second = await postEvent({
      name: `${RUN}.login`,
      email: A_EMAIL,
      userId: A_USER,
      anonymousId: A_ANON,
      eventProperties: {},
    });
    expect(second.status).toBe(202);
    const secondBody = await second.json();

    // Same row (no twin), now keyed by the external_id.
    expect(secondBody.contactKey).toBe(A_USER);
    const rows = await db
      .select()
      .from(contacts)
      .where(eq(contacts.email, A_EMAIL));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(created.id);
    expect(rows[0]?.externalId).toBe(A_USER);
    expect(rows[0]?.anonymousId).toBe(A_ANON);

    // Exactly ONE merge, in the SURVIVOR direction (MF-1, asserted against the
    // PostHog-docs rule, NOT the misleading posthog-node .d.ts example):
    //   distinctId = the SURVIVING/canonical (now-identified) external_id,
    //   alias      = the ABSORBED anon id the contact's events were keyed under.
    // The anon id is the absorbed side; the canonical external_id never appears
    // as `alias`.
    expect(mergeSpy).toHaveBeenCalledTimes(1);
    expect(mergeSpy).toHaveBeenCalledWith({
      distinctId: A_USER,
      alias: A_ANON,
    });
  });
});
