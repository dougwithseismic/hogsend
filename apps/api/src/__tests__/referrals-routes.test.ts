/**
 * PRD 05 stage 5 - the `/v1/referrals` ROUTES against a real DB.
 *
 * The report assertions are EXACT numbers, not shapes. A weighted multi-level
 * credit split that is merely "a number" is a test that certifies rather than
 * fails: the whole feature is the arithmetic, so the fixture is a hand-checked
 * 3-deep chain and every expected value is written out longhand.
 *
 * The other load-bearing assertions are the boundaries:
 *  - `/import` is SILENT (no `referral.*` lands on the journey plane);
 *  - `/me` never confirms existence (forged/absent token = the empty answer);
 *  - the secret plane needs the ORTHOGONAL `referrals` scope, and a
 *    publishable key never reaches it.
 */
import { createHash } from "node:crypto";
import type { HogsendClient } from "@hogsend/engine";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { apiKeys, contacts, conversions, links, referralTouches, userEvents } =
  await import("@hogsend/db");
const { eq, inArray, like } = await import("drizzle-orm");
const {
  createApp,
  createHogsendClient,
  defineReferral,
  generateUserToken,
  getReferralLink,
} = await import("@hogsend/engine");

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

const RUN = `refr-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const SECRET = "test-secret-for-vitest-minimum-32-characters-long";
const ORIGIN = "https://app.example.com";
const SECRET_KEY = `sk_test_${RUN}`;
const NO_SCOPE_KEY = `sk_noscope_${RUN}`;
const PK_KEY = `pk_test_${RUN}`;

const invite = defineReferral({
  id: `${RUN}-invite`,
  link: { destination: "https://example.com/join" },
});

const container = createHogsendClient({
  referrals: [invite],
  overrides: { hatchet: mockHatchet },
});
const app = createApp(container);
const { db } = container;

const REFERRAL = invite.id;
const DAY = 86_400_000;
const T0 = new Date("2026-01-10T00:00:00.000Z");

const keyIds: string[] = [];
const contactIds: string[] = [];

const hashKey = (raw: string) => createHash("sha256").update(raw).digest("hex");

/** A, B, C, D form the chain; the rest are the model/window fixtures. */
const ids: Record<string, string> = {};

async function makeContact(label: string): Promise<string> {
  const [row] = await db
    .insert(contacts)
    .values({
      externalId: `${RUN}-${label}`,
      email: `${RUN}-${label}@example.test`,
    })
    .returning({ id: contacts.id });
  if (!row) throw new Error(`contact insert failed for ${label}`);
  contactIds.push(row.id);
  ids[label] = row.id;
  return row.id;
}

/** One eligible edge, written at the store level so the clock is exact. */
async function edge(opts: {
  referrer: string;
  referee: string;
  touchedAt: Date;
  /** Touch -> bind gap. Default 1 day (inside every window under test). */
  bindGapMs?: number;
  status?: "bound" | "qualified";
}) {
  const boundAt = new Date(opts.touchedAt.getTime() + (opts.bindGapMs ?? DAY));
  await db.insert(referralTouches).values({
    referralId: REFERRAL,
    referrerContactId: ids[opts.referrer] as string,
    refereeKey: `${RUN}-${opts.referee}`,
    refereeContactId: ids[opts.referee] as string,
    source: "manual",
    touchedAt: opts.touchedAt,
    boundAt,
    status: opts.status ?? "bound",
  });
}

/** A conversion for `label`, with the `user_events` row its FK needs. */
async function conversion(opts: {
  label: string;
  value: number;
  currency?: string;
  occurredAt?: Date;
}) {
  const contactId = ids[opts.label] as string;
  const occurredAt = opts.occurredAt ?? new Date(T0.getTime() + 10 * DAY);
  const [event] = await db
    .insert(userEvents)
    .values({
      userId: `${RUN}-${opts.label}`,
      contactId,
      event: "order.completed",
      occurredAt,
    })
    .returning({ id: userEvents.id });
  await db.insert(conversions).values({
    definitionId: `${RUN}-purchase`,
    contactId,
    userKey: `${RUN}-${opts.label}`,
    eventId: event?.id as string,
    value: opts.value,
    currency: opts.currency ?? "USD",
    occurredAt,
  });
}

function get(path: string, key = SECRET_KEY) {
  return app.request(path, { headers: { Authorization: `Bearer ${key}` } });
}

function post(path: string, body: unknown, key = SECRET_KEY) {
  return app.request(path, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

/** The one beneficiary we asked about, or undefined. */
type Beneficiary = {
  contactId: string;
  direct: { touched: number; bound: number; qualified: number };
  tree: {
    level: number;
    referees: number;
    conversions: number;
    value: { currency: string; value: number }[];
  }[];
  value: { currency: string; value: number }[];
};

async function report(query: string): Promise<Beneficiary[]> {
  const res = await get(`/v1/referrals/report?referral=${REFERRAL}&${query}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { beneficiaries: Beneficiary[] };
  return body.beneficiaries;
}

const forId = (rows: Beneficiary[], label: string) =>
  rows.find((r) => r.contactId === ids[label]);

beforeAll(async () => {
  for (const [raw, scopes, origins] of [
    [SECRET_KEY, ["referrals"], null],
    [NO_SCOPE_KEY, ["ingest"], null],
    [PK_KEY, ["ingest-public"], [ORIGIN]],
  ] as const) {
    const [row] = await db
      .insert(apiKeys)
      .values({
        name: `${RUN} ${raw.slice(0, 6)}`,
        keyPrefix: raw.slice(0, 8),
        keyHash: hashKey(raw),
        scopes: [...scopes],
        ...(origins ? { allowedOrigins: [...origins] } : {}),
      })
      .returning({ id: apiKeys.id });
    keyIds.push(row?.id as string);
  }

  for (const label of ["a", "b", "c", "d", "p1", "p2", "x", "stale", "sref"]) {
    await makeContact(label);
  }

  // The chain: A -> B -> C -> D, one edge each, all inside a 30d window.
  await edge({ referrer: "a", referee: "b", touchedAt: T0 });
  await edge({ referrer: "b", referee: "c", touchedAt: T0 });
  await edge({ referrer: "c", referee: "d", touchedAt: T0 });
  await conversion({ label: "b", value: 100 });
  await conversion({ label: "c", value: 200 });
  await conversion({ label: "d", value: 400 });

  // X was touched by P1 first and P2 second: first_touch credits P1,
  // last_touch credits P2.
  await edge({ referrer: "p1", referee: "x", touchedAt: T0 });
  await edge({
    referrer: "p2",
    referee: "x",
    touchedAt: new Date(T0.getTime() + 2 * DAY),
  });
  await conversion({ label: "x", value: 50 });

  // STALE bound 60 days after the touch: eligible under `window=90d`, gone
  // under the 30d default.
  await edge({
    referrer: "sref",
    referee: "stale",
    touchedAt: T0,
    bindGapMs: 60 * DAY,
  });
  await conversion({ label: "stale", value: 999 });
});

afterAll(async () => {
  await db
    .delete(referralTouches)
    .where(eq(referralTouches.referralId, REFERRAL));
  await db
    .delete(conversions)
    .where(eq(conversions.definitionId, `${RUN}-purchase`));
  await db.delete(userEvents).where(like(userEvents.userId, `${RUN}%`));
  await db.delete(links).where(like(links.source, "referral"));
  if (contactIds.length > 0) {
    await db.delete(contacts).where(inArray(contacts.id, contactIds));
  }
  if (keyIds.length > 0) {
    await db.delete(apiKeys).where(inArray(apiKeys.id, keyIds));
  }
  await container.dbClient.end();
});

describe("GET /v1/referrals/report", () => {
  it("credits only the direct referrer at depth 1", async () => {
    const rows = await report("model=first_touch&depth=1");
    const a = forId(rows, "a");
    expect(a?.tree).toEqual([
      {
        level: 1,
        referees: 1,
        conversions: 1,
        value: [{ currency: "USD", value: 100 }],
      },
    ]);
    expect(a?.value).toEqual([{ currency: "USD", value: 100 }]);
    // C and D are in A's TREE, not A's direct touches.
    expect(a?.direct).toEqual({ touched: 1, bound: 1, qualified: 0 });
  });

  it("walks three levels and applies the level weights exactly", async () => {
    const rows = await report("model=first_touch&depth=3&weights=1,0.5,0.25");
    const a = forId(rows, "a");
    expect(a?.tree).toEqual([
      {
        level: 1,
        referees: 1,
        conversions: 1,
        value: [{ currency: "USD", value: 100 }],
      },
      {
        level: 2,
        referees: 1,
        conversions: 1,
        value: [{ currency: "USD", value: 100 }],
      },
      {
        level: 3,
        referees: 1,
        conversions: 1,
        value: [{ currency: "USD", value: 100 }],
      },
    ]);
    // 1*100 + 0.5*200 + 0.25*400 = 300.
    expect(a?.value).toEqual([{ currency: "USD", value: 300 }]);
  });

  it("gives deeper levels zero value when no weights are supplied", async () => {
    const rows = await report("model=first_touch&depth=3");
    const a = forId(rows, "a");
    expect(a?.tree.map((t) => t.referees)).toEqual([1, 1, 1]);
    expect(a?.value).toEqual([{ currency: "USD", value: 100 }]);
  });

  it("first_touch credits the earliest referrer, last_touch the latest", async () => {
    const first = await report("model=first_touch&depth=1");
    expect(forId(first, "p1")?.value).toEqual([{ currency: "USD", value: 50 }]);
    // Under first_touch p2's edge scores zero and is dropped entirely, so p2
    // is not a beneficiary at all rather than one worth nothing.
    expect(forId(first, "p2")).toBeUndefined();

    const last = await report("model=last_touch&depth=1");
    expect(forId(last, "p2")?.value).toEqual([{ currency: "USD", value: 50 }]);
    expect(forId(last, "p1")).toBeUndefined();
  });

  it("splits a shared referee evenly under linear", async () => {
    const rows = await report("model=linear&depth=1");
    expect(forId(rows, "p1")?.value).toEqual([{ currency: "USD", value: 25 }]);
    expect(forId(rows, "p2")?.value).toEqual([{ currency: "USD", value: 25 }]);
  });

  it("excludes an edge whose bind fell outside the window", async () => {
    const inside = await report("model=first_touch&depth=1&window=90d");
    expect(forId(inside, "sref")?.value).toEqual([
      { currency: "USD", value: 999 },
    ]);

    const outside = await report("model=first_touch&depth=1&window=30d");
    expect(forId(outside, "sref")).toBeUndefined();
  });

  it("filters conversions by from/to", async () => {
    const before = await report(
      "model=first_touch&depth=1&to=2026-01-01T00:00:00.000Z",
    );
    // The TREE is unchanged by a conversion filter - A still referred B - but
    // there is no revenue in the window, so every value list is empty.
    const a = forId(before, "a");
    expect(a?.tree).toEqual([
      { level: 1, referees: 1, conversions: 0, value: [] },
    ]);
    expect(a?.value).toEqual([]);
  });

  it("rejects an unparseable window with 400", async () => {
    const res = await get("/v1/referrals/report?window=thirty-days");
    expect(res.status).toBe(400);
  });
});

describe("GET /v1/referrals/tree/:contactId", () => {
  it("returns the descendants with their level and conversion totals", async () => {
    const res = await get(
      `/v1/referrals/tree/${ids.a}?referral=${REFERRAL}&depth=3`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      nodes: {
        contactId: string;
        level: number;
        viaContactId: string;
        conversions: number;
        value: { currency: string; value: number }[];
      }[];
    };
    expect(body.nodes.map((n) => [n.contactId, n.level])).toEqual([
      [ids.b, 1],
      [ids.c, 2],
      [ids.d, 3],
    ]);
    expect(body.nodes[0]?.viaContactId).toBe(ids.a);
    expect(body.nodes[2]?.value).toEqual([{ currency: "USD", value: 400 }]);
  });

  it("stops at the requested depth", async () => {
    const res = await get(
      `/v1/referrals/tree/${ids.a}?referral=${REFERRAL}&depth=1`,
    );
    const body = (await res.json()) as { nodes: unknown[] };
    expect(body.nodes).toHaveLength(1);
  });
});

describe("POST /v1/referrals/touch", () => {
  it("resolves the referrer from a shared link slug", async () => {
    const referrer = await makeContact("slugowner");
    const referee = await makeContact("slugreferee");
    const link = await getReferralLink({
      referral: invite,
      contactId: referrer,
      container: {
        db,
        env: { API_PUBLIC_URL: container.env.API_PUBLIC_URL },
        referrals: container.referrals,
      },
    });
    // `getReferralLink` mints a slugless link for a program with no `slugFrom`,
    // so give this one a slug to address it by.
    const slug = `${RUN}-slug`;
    await db.update(links).set({ slug }).where(eq(links.id, link.linkId));

    const res = await post("/v1/referrals/touch", {
      slug,
      refereeContactId: referee,
      source: "slug_entry",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      referrerContactId: string;
      refereeContactId: string;
      status: string;
      created: boolean;
    };
    expect(body.referrerContactId).toBe(referrer);
    expect(body.refereeContactId).toBe(referee);
    expect(body.status).toBe("bound");
    expect(body.created).toBe(true);
  });

  it("lets the slug's own referral win over a body `referral`", async () => {
    const referrer = await makeContact("slugwins-owner");
    const referee = await makeContact("slugwins-referee");
    const link = await getReferralLink({
      referral: invite,
      contactId: referrer,
      container: {
        db,
        env: { API_PUBLIC_URL: container.env.API_PUBLIC_URL },
        referrals: container.referrals,
      },
    });
    const slug = `${RUN}-slugwins`;
    await db.update(links).set({ slug }).where(eq(links.id, link.linkId));

    const res = await post("/v1/referrals/touch", {
      slug,
      referral: `${RUN}-not-registered`,
      refereeContactId: referee,
      source: "slug_entry",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      referral: string;
      referrerContactId: string;
    };
    expect(body.referral).toBe(REFERRAL);
    expect(body.referrerContactId).toBe(referrer);
  });

  it("404s an unknown slug", async () => {
    const res = await post("/v1/referrals/touch", {
      slug: `${RUN}-nope`,
      refereeKey: "anon-1",
      source: "invite",
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /v1/referrals/import", () => {
  it("binds an imported touch and emits NOTHING", async () => {
    const referrer = await makeContact("imprefer");
    const referee = await makeContact("impreferee");

    const res = await post("/v1/referrals/import", {
      referral: REFERRAL,
      touches: [
        {
          referrerContactId: referrer,
          refereeContactId: referee,
          touchedAt: T0.toISOString(),
        },
        // A self-referral is refused by identity, not a heuristic.
        {
          referrerContactId: referrer,
          refereeContactId: referrer,
          touchedAt: T0.toISOString(),
        },
      ],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      referral: REFERRAL,
      inserted: 1,
      existing: 0,
      rejected: 1,
      skipped: 0,
    });

    const rows = await db
      .select()
      .from(referralTouches)
      .where(eq(referralTouches.referrerContactId, referrer));
    expect(rows.map((r) => r.status).sort()).toEqual(["bound", "rejected"]);
    expect(rows.every((r) => r.source === "import")).toBe(true);

    // Silence is the point: an import must not fire a reward journey. Give the
    // fire-and-forget emit plane a beat before asserting it never ran.
    await new Promise((r) => setTimeout(r, 300));
    const events = await db
      .select({ event: userEvents.event })
      .from(userEvents)
      .where(inArray(userEvents.contactId, [referrer, referee]));
    expect(events.filter((e) => e.event.startsWith("referral."))).toEqual([]);
  });

  it("is insert-only: a repeat of the same edge is `existing`", async () => {
    const referrer = ids.imprefer as string;
    const referee = ids.impreferee as string;
    const res = await post("/v1/referrals/import", {
      referral: REFERRAL,
      touches: [
        {
          referrerContactId: referrer,
          refereeContactId: referee,
          touchedAt: T0.toISOString(),
        },
      ],
    });
    expect(await res.json()).toMatchObject({ inserted: 0, existing: 1 });
  });
});

describe("GET /v1/referrals/me", () => {
  const me = (query: string) =>
    app.request(`/v1/referrals/me?referral=${REFERRAL}&${query}`, {
      headers: { Authorization: `Bearer ${PK_KEY}`, Origin: ORIGIN },
    });

  it("returns two nulls for an absent token", async () => {
    const res = await me("");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ link: null, stats: null });
  });

  it("returns the SAME body for a forged token", async () => {
    const forged = `${generateUserToken({ secret: "not-the-secret-but-long-enough-abcdefgh", userId: `${RUN}-a` })}`;
    const res = await me(`userToken=${encodeURIComponent(forged)}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(JSON.stringify({ link: null, stats: null }));
  });

  it("returns the SAME body for a token naming nobody", async () => {
    const token = generateUserToken({
      secret: SECRET,
      userId: `${RUN}-nobody-at-all`,
    });
    const res = await me(`userToken=${encodeURIComponent(token)}`);
    expect(await res.text()).toBe(JSON.stringify({ link: null, stats: null }));
  });

  it("mints the caller's link and reports their counts", async () => {
    const token = generateUserToken({ secret: SECRET, userId: `${RUN}-a` });
    const res = await me(`userToken=${encodeURIComponent(token)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      link: { url: string; slug: string | null } | null;
      stats: { touched: number; bound: number; qualified: number } | null;
    };
    expect(body.link?.url).toContain("/v1/t/c/");
    expect(body.stats).toEqual({ touched: 1, bound: 1, qualified: 0 });
  });
});

describe("the referrals scope", () => {
  it("403s a secret key without the referrals scope", async () => {
    const res = await get("/v1/referrals/report", NO_SCOPE_KEY);
    expect(res.status).toBe(403);
  });

  it("403s a secret key without the scope on the tree route", async () => {
    const res = await get(`/v1/referrals/tree/${ids.a}`, NO_SCOPE_KEY);
    expect(res.status).toBe(403);
  });

  it("401s an unauthenticated report request", async () => {
    const res = await app.request("/v1/referrals/report");
    expect(res.status).toBe(401);
  });

  it("403s a publishable key on the report", async () => {
    const res = await app.request("/v1/referrals/report", {
      headers: { Authorization: `Bearer ${PK_KEY}`, Origin: ORIGIN },
    });
    expect(res.status).toBe(403);
  });
});
