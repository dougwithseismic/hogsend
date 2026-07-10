import { afterAll, describe, expect, it, vi } from "vitest";

// DB-touching test (mirrors links-qr): arrival attribution spans the redirect
// (`hs_ref` append), the arrive endpoint, and stamped click rows — real
// docker TimescaleDB required.
process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";
// hs_ref must coexist with hs_t on personal links — force the token path on.
process.env.TRACKING_IDENTITY_TOKEN = "true";

vi.mock("../lib/hatchet.js", () => ({
  hatchet: {
    durableTask: vi.fn(() => ({
      run: vi.fn(),
      runNoWait: vi.fn(),
      runAndWait: vi.fn(),
    })),
    task: vi.fn(() => ({ run: vi.fn(), runNoWait: vi.fn() })),
    events: { push: vi.fn() },
    runs: { cancel: vi.fn(), get: vi.fn() },
    worker: vi.fn(),
  },
}));

vi.mock("../workflows/send-email.js", () => ({
  sendEmailTask: { run: vi.fn(), runNoWait: vi.fn() },
}));

const { contacts, linkClicks, links, trackedLinks, userEvents } = await import(
  "@hogsend/db"
);
const { eq, inArray } = await import("drizzle-orm");
const { createApp, createHogsendClient, generateUserToken } = await import(
  "@hogsend/engine"
);
type HogsendClient = ReturnType<typeof createHogsendClient>;

// The arrive route AWAITS ingestEvent, whose Hatchet push failure triggers the
// compensating delete of the just-claimed user_events row — so unlike the
// fire-and-forget click emits, these tests need the container's hatchet
// mocked, not just apps/api's module-level one.
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

const container = createHogsendClient({ overrides: { hatchet: mockHatchet } });
const app = createApp(container);
const { db, env } = container;

const AUTH_HEADER = { Authorization: `Bearer ${process.env.ADMIN_API_KEY}` };
const JSON_HEADERS = { ...AUTH_HEADER, "Content-Type": "application/json" };

const RUN = `arrive-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const createdLinkIds: string[] = [];
const arrivedRefs: string[] = [];
const createdContactKeys: string[] = [];

afterAll(async () => {
  if (arrivedRefs.length > 0) {
    await db.delete(userEvents).where(
      inArray(
        userEvents.idempotencyKey,
        arrivedRefs.map((r) => `link:arrived:${r}`),
      ),
    );
  }
  if (createdContactKeys.length > 0) {
    await db
      .delete(contacts)
      .where(inArray(contacts.anonymousId, createdContactKeys));
    await db
      .delete(contacts)
      .where(inArray(contacts.externalId, createdContactKeys));
  }
  for (const id of createdLinkIds) {
    const tracked = await db
      .select({ id: trackedLinks.id })
      .from(trackedLinks)
      .where(eq(trackedLinks.linkId, id));
    for (const t of tracked) {
      await db.delete(linkClicks).where(eq(linkClicks.trackedLinkId, t.id));
    }
    await db.delete(trackedLinks).where(eq(trackedLinks.linkId, id));
    await db.delete(links).where(eq(links.id, id));
  }
});

async function mint(body: Record<string, unknown> = {}) {
  const res = await app.request("/v1/admin/links", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      url: "https://example.com/arrive",
      label: `${RUN}-link`,
      ...body,
    }),
  });
  const json = await res.json();
  if (json.id) createdLinkIds.push(json.id);
  return json;
}

function refFromLocation(location: string | null): string | null {
  if (!location) return null;
  return new URL(location).searchParams.get("hs_ref");
}

describe("arrival ref — redirect append (7.1)", () => {
  it("appendRef round-trips through mint, PATCH and responses", async () => {
    const off = await mint({ label: `${RUN}-flag-default` });
    expect(off.appendRef).toBe(false);

    const on = await mint({ label: `${RUN}-flag-on`, appendRef: true });
    expect(on.appendRef).toBe(true);

    const patched = await app.request(`/v1/admin/links/${off.id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ appendRef: true }),
    });
    expect((await patched.json()).appendRef).toBe(true);
  });

  it("opted-in redirects carry hs_ref = the click row id; opted-out carry none", async () => {
    const on = await mint({ label: `${RUN}-ref-on`, appendRef: true });
    const res = await app.request(`/v1/t/c/${on.trackedLinkId}`, {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    const ref = refFromLocation(res.headers.get("location"));
    expect(ref).toMatch(/^[0-9a-f-]{36}$/);

    // The ref IS the click row's id, and destinationUrl stays undecorated.
    const [row] = await db
      .select({
        id: linkClicks.id,
        destinationUrl: linkClicks.destinationUrl,
      })
      .from(linkClicks)
      .where(eq(linkClicks.id, ref ?? ""));
    expect(row?.id).toBe(ref);
    expect(row?.destinationUrl).toBe("https://example.com/arrive");

    const off = await mint({ label: `${RUN}-ref-off` });
    const resOff = await app.request(`/v1/t/c/${off.trackedLinkId}`, {
      redirect: "manual",
    });
    expect(refFromLocation(resOff.headers.get("location"))).toBeNull();
  });

  it("hs_ref coexists with hs_t on a personal link (single URL-build pass)", async () => {
    const personal = await mint({
      label: `${RUN}-personal`,
      type: "personal",
      distinctId: "arrive-contact-1",
      appendRef: true,
    });
    const res = await app.request(`/v1/t/c/${personal.trackedLinkId}`, {
      redirect: "manual",
    });
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.searchParams.get("hs_t")).toBeTruthy();
    expect(location.searchParams.get("hs_ref")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("each hit gets a distinct ref", async () => {
    const link = await mint({ label: `${RUN}-distinct`, appendRef: true });
    const refs = new Set<string | null>();
    for (let i = 0; i < 3; i++) {
      const res = await app.request(`/v1/t/c/${link.trackedLinkId}`, {
        redirect: "manual",
      });
      refs.add(refFromLocation(res.headers.get("location")));
    }
    expect(refs.size).toBe(3);
  });
});

async function clickForRef(trackedLinkId: string): Promise<string> {
  const res = await app.request(`/v1/t/c/${trackedLinkId}`, {
    redirect: "manual",
  });
  const ref = refFromLocation(res.headers.get("location"));
  if (!ref) throw new Error("expected hs_ref on redirect");
  arrivedRefs.push(ref);
  return ref;
}

async function arrive(body: Record<string, unknown>) {
  return app.request("/v1/t/arrive", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function stampOf(ref: string) {
  const [row] = await db
    .select({
      visitorDistinctId: linkClicks.visitorDistinctId,
      visitorKind: linkClicks.visitorKind,
      arrivedAt: linkClicks.arrivedAt,
    })
    .from(linkClicks)
    .where(eq(linkClicks.id, ref));
  return row;
}

async function arrivedEvents(ref: string) {
  return db
    .select({
      userId: userEvents.userId,
      event: userEvents.event,
    })
    .from(userEvents)
    .where(eq(userEvents.idempotencyKey, `link:arrived:${ref}`));
}

describe("POST /v1/t/arrive (7.2)", () => {
  it("anon arrival stamps the click row and emits link.arrived (clamped)", async () => {
    const link = await mint({ label: `${RUN}-anon`, appendRef: true });
    const ref = await clickForRef(link.trackedLinkId);
    const anonId = `${RUN}-anon-visitor`;
    createdContactKeys.push(anonId);

    const res = await arrive({ ref, anonymousId: anonId });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const stamp = await stampOf(ref);
    expect(stamp?.visitorDistinctId).toBe(anonId);
    expect(stamp?.visitorKind).toBe("anon");
    expect(stamp?.arrivedAt).not.toBeNull();

    const events = await arrivedEvents(ref);
    expect(events.length).toBe(1);
    expect(events[0]?.event).toBe("link.arrived");
    expect(events[0]?.userId).toBe(anonId);
  });

  it("token arrival stamps kind=token with the verified userId", async () => {
    const link = await mint({ label: `${RUN}-token`, appendRef: true });
    const ref = await clickForRef(link.trackedLinkId);
    const userId = `${RUN}-known-user`;
    createdContactKeys.push(userId);
    const userToken = generateUserToken({
      userId,
      secret: env.BETTER_AUTH_SECRET,
    });

    const res = await arrive({ ref, userToken });
    expect(res.status).toBe(200);

    const stamp = await stampOf(ref);
    expect(stamp?.visitorDistinctId).toBe(userId);
    expect(stamp?.visitorKind).toBe("token");

    const events = await arrivedEvents(ref);
    expect(events.length).toBe(1);
    expect(events[0]?.userId).toBe(userId);
  });

  it("replay with a DIFFERENT identity keeps the original stamp and never double-fires", async () => {
    const link = await mint({ label: `${RUN}-replay`, appendRef: true });
    const ref = await clickForRef(link.trackedLinkId);
    const first = `${RUN}-first-visitor`;
    const second = `${RUN}-second-visitor`;
    createdContactKeys.push(first, second);

    await arrive({ ref, anonymousId: first });
    const replay = await arrive({ ref, anonymousId: second });
    expect(replay.status).toBe(200);

    const stamp = await stampOf(ref);
    expect(stamp?.visitorDistinctId).toBe(first);

    const events = await arrivedEvents(ref);
    expect(events.length).toBe(1);
    expect(events[0]?.userId).toBe(first);
  });

  it("an anonymousId colliding with an identified contact is rejected: no stamp, no event, 200", async () => {
    const victimKey = `${RUN}-victim-external`;
    createdContactKeys.push(victimKey);
    await db.insert(contacts).values({
      externalId: victimKey,
      email: `${RUN}-victim@example.com`,
    });

    const link = await mint({ label: `${RUN}-collision`, appendRef: true });
    const ref = await clickForRef(link.trackedLinkId);

    const res = await arrive({ ref, anonymousId: victimKey });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const stamp = await stampOf(ref);
    expect(stamp?.visitorDistinctId).toBeNull();
    expect((await arrivedEvents(ref)).length).toBe(0);
  });

  it("never uses the link's own distinctId as a subject (invariant)", async () => {
    const victimContactKey = `${RUN}-link-subject`;
    createdContactKeys.push(victimContactKey, `${RUN}-innocent-anon`);
    const personal = await mint({
      label: `${RUN}-invariant`,
      type: "personal",
      distinctId: victimContactKey,
      appendRef: true,
    });
    const ref = await clickForRef(personal.trackedLinkId);

    await arrive({ ref, anonymousId: `${RUN}-innocent-anon` });

    // The stamp + event subject are the VISITOR's anon id — the link's
    // distinctId never enters the resolver from the arrive path.
    const stamp = await stampOf(ref);
    expect(stamp?.visitorDistinctId).toBe(`${RUN}-innocent-anon`);
    const events = await arrivedEvents(ref);
    expect(events.length).toBe(1);
    expect(events[0]?.userId).toBe(`${RUN}-innocent-anon`);
    expect(events[0]?.userId).not.toBe(victimContactKey);
  });

  it("no-ops uniformly: unknown ref, opted-out link, no identity, invalid token", async () => {
    // Unknown ref.
    const unknown = await arrive({
      ref: "00000000-0000-0000-0000-000000000000",
      anonymousId: `${RUN}-x`,
    });
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toEqual({ ok: true });

    // Opted-out link: the click row exists but the link never opted in — a
    // ref obtained out-of-band is a no-op.
    const off = await mint({ label: `${RUN}-optout` });
    await app.request(`/v1/t/c/${off.trackedLinkId}`, { redirect: "manual" });
    const [offClick] = await db
      .select({ id: linkClicks.id })
      .from(linkClicks)
      .where(eq(linkClicks.trackedLinkId, off.trackedLinkId));
    const offRes = await arrive({
      ref: offClick?.id,
      anonymousId: `${RUN}-y`,
    });
    expect(offRes.status).toBe(200);
    expect((await stampOf(offClick?.id ?? ""))?.visitorDistinctId).toBeNull();

    // No identity supplied.
    const on = await mint({ label: `${RUN}-noid`, appendRef: true });
    const ref = await clickForRef(on.trackedLinkId);
    const noId = await arrive({ ref });
    expect(noId.status).toBe(200);
    expect((await stampOf(ref))?.visitorDistinctId).toBeNull();

    // Invalid userToken — same uniform 200, no stamp.
    const badToken = await arrive({ ref, userToken: "not-a-real-token" });
    expect(badToken.status).toBe(200);
    expect(await badToken.json()).toEqual({ ok: true });
    expect((await stampOf(ref))?.visitorDistinctId).toBeNull();

    // Malformed ref (not a uuid) → 400 (the only non-200).
    const malformed = await arrive({ ref: "nope", anonymousId: "x" });
    expect(malformed.status).toBe(400);
  });
});
