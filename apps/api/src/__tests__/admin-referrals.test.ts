/**
 * PRD 05 stage 6 - the read-only ADMIN referral surface the Studio views
 * consume. It reuses the same report functions as `/v1/referrals`, so this
 * suite pins what the admin router adds on top: contact identity on every
 * beneficiary/node, the touch log (rejected rows and their reason included),
 * the registered program ids for the picker, and the admin guard.
 */
import type { HogsendClient } from "@hogsend/engine";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { contacts, conversions, referralTouches, userEvents } = await import(
  "@hogsend/db"
);
const { eq, like } = await import("drizzle-orm");
const { createApp, createHogsendClient, defineReferral } = await import(
  "@hogsend/engine"
);

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

const RUN = `adref-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

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

const AUTH_HEADER = { Authorization: `Bearer ${process.env.ADMIN_API_KEY}` };
const REFERRAL = invite.id;
const DAY = 86_400_000;
const T0 = new Date("2026-02-01T00:00:00.000Z");

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
  ids[label] = row.id;
  return row.id;
}

beforeAll(async () => {
  await makeContact("a");
  await makeContact("b");
  await makeContact("c");

  // A referred B (bound + qualified), B referred C, and A also has one
  // REJECTED self-touch so the touch log has a reason to show.
  await db.insert(referralTouches).values([
    {
      referralId: REFERRAL,
      referrerContactId: ids.a as string,
      refereeKey: `${RUN}-b`,
      refereeContactId: ids.b as string,
      source: "link",
      touchedAt: T0,
      boundAt: new Date(T0.getTime() + DAY),
      status: "qualified",
      qualifiedAt: new Date(T0.getTime() + DAY),
    },
    {
      referralId: REFERRAL,
      referrerContactId: ids.b as string,
      refereeKey: `${RUN}-c`,
      refereeContactId: ids.c as string,
      source: "link",
      touchedAt: new Date(T0.getTime() + 2 * DAY),
      boundAt: new Date(T0.getTime() + 3 * DAY),
      status: "bound",
    },
    {
      referralId: REFERRAL,
      referrerContactId: ids.a as string,
      refereeKey: `${RUN}-a`,
      refereeContactId: ids.a as string,
      source: "slug_entry",
      touchedAt: new Date(T0.getTime() + 4 * DAY),
      status: "rejected",
      rejectedReason: "self",
    },
  ]);

  // B converts for 100 USD, so A's level-1 credit is exactly 100.
  const occurredAt = new Date(T0.getTime() + 5 * DAY);
  const [event] = await db
    .insert(userEvents)
    .values({
      userId: `${RUN}-b`,
      contactId: ids.b as string,
      event: "order.completed",
      occurredAt,
    })
    .returning({ id: userEvents.id });
  await db.insert(conversions).values({
    definitionId: `${RUN}-purchase`,
    contactId: ids.b as string,
    userKey: `${RUN}-b`,
    eventId: event?.id as string,
    value: 100,
    currency: "USD",
    occurredAt,
  });
});

afterAll(async () => {
  await db
    .delete(referralTouches)
    .where(eq(referralTouches.referralId, REFERRAL));
  await db.delete(userEvents).where(like(userEvents.userId, `${RUN}%`));
  await db.delete(contacts).where(like(contacts.externalId, `${RUN}%`));
});

describe("GET /v1/admin/referrals", () => {
  it("ranks referrers, names them, and lists the registered programs", async () => {
    const res = await app.request(
      `/v1/admin/referrals?referral=${encodeURIComponent(REFERRAL)}`,
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      referral: string;
      referrals: string[];
      model: string;
      weights: number[];
      beneficiaries: {
        contactId: string;
        contact: { email: string | null } | null;
        direct: { touched: number; bound: number; qualified: number };
        value: { currency: string; value: number }[];
      }[];
    };

    expect(body.referral).toBe(REFERRAL);
    expect(body.referrals).toContain(REFERRAL);
    expect(body.model).toBe("first_touch");
    expect(body.weights).toEqual([1]);

    const a = body.beneficiaries.find((b) => b.contactId === ids.a);
    expect(a).toBeDefined();
    // Identity is what the admin router adds over the data plane.
    expect(a?.contact?.email).toBe(`${RUN}-a@example.test`);
    // The whole 100 lands at level 1, unconverted and per currency.
    expect(a?.value).toEqual([{ currency: "USD", value: 100 }]);
    // Direct counts are NOT model-filtered, and the rejected touch counts in
    // neither `bound` nor `qualified`.
    expect(a?.direct).toEqual({ touched: 1, bound: 1, qualified: 1 });
  });

  it("rejects an unparseable window with a 400", async () => {
    const res = await app.request("/v1/admin/referrals?window=soon", {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(400);
  });

  it("401s without the admin credential", async () => {
    const res = await app.request("/v1/admin/referrals");
    expect(res.status).toBe(401);
  });
});

describe("GET /v1/admin/referrals/:contactId", () => {
  it("returns the tree and the touch log with the rejection reason", async () => {
    const res = await app.request(
      `/v1/admin/referrals/${ids.a}?referral=${encodeURIComponent(REFERRAL)}&depth=2`,
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      contactId: string;
      contact: { email: string | null } | null;
      nodes: { contactId: string; level: number; viaContactId: string }[];
      touches: { status: string; rejectedReason: string | null }[];
    };

    expect(body.contactId).toBe(ids.a);
    expect(body.contact?.email).toBe(`${RUN}-a@example.test`);

    const levels = body.nodes.map((n) => [n.contactId, n.level]);
    expect(levels).toEqual(
      expect.arrayContaining([
        [ids.b, 1],
        [ids.c, 2],
      ]),
    );
    // The next hop up is a fact on the node, so a UI can name the path.
    expect(body.nodes.find((n) => n.contactId === ids.c)?.viaContactId).toBe(
      ids.b,
    );

    const rejected = body.touches.find((t) => t.status === "rejected");
    expect(rejected?.rejectedReason).toBe("self");
  });

  it("answers an unknown contact with an empty tree, not a 404", async () => {
    const res = await app.request(
      "/v1/admin/referrals/00000000-0000-0000-0000-000000000000",
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { nodes: unknown[]; touches: unknown[] };
    expect(body.nodes).toEqual([]);
    expect(body.touches).toEqual([]);
  });
});
