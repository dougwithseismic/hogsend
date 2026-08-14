import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fakeAccountLink } from "./account-link-fakes.js";

process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { hatchetMock } = vi.hoisted(() => {
  const factory = () => ({
    hatchet: {
      durableTask: vi.fn((config: Record<string, unknown>) => ({
        ...config,
        run: vi.fn(),
        runNoWait: vi.fn(),
        runAndWait: vi.fn(),
      })),
      task: vi.fn((config: Record<string, unknown>) => ({
        ...config,
        run: vi.fn(),
        runNoWait: vi.fn(async () => ({})),
      })),
      events: { push: vi.fn() },
      runs: { cancel: vi.fn(), get: vi.fn() },
      worker: vi.fn(),
    },
  });
  return { hatchetMock: factory };
});

vi.mock("../../../../packages/engine/src/lib/hatchet.ts", () => hatchetMock());
vi.mock("../lib/hatchet.js", () => hatchetMock());

const {
  apiKeys,
  contacts,
  createDatabase,
  linkedAccounts,
  webhookDeliveries,
  webhookEndpoints,
} = await import("@hogsend/db");
const { and, asc, eq, like, sql } = await import("drizzle-orm");
const engine = await import("@hogsend/engine");
const { createApp, createHogsendClient } = engine;

/**
 * PRD 09 T5 — THE SECURITY PROOF FOR DECISIONS §6.2.
 *
 * `POST /v1/accounts/import` is the ONE carve-out that writes links without a
 * hosted callback, and it is INSERT-ONLY. **Only a completed hosted callback
 * may move a link** (DECISIONS §6.1), because only the callback carries proof
 * of control of the platform account. An import that could displace a live
 * owner would let anyone holding a secret key graft any player's Steam account
 * onto any contact — silently, at scale, in one request.
 *
 * The central case therefore asserts the existing row is BYTE-IDENTICAL after
 * the refused import (same contact, same version, same `linkedAt`), not merely
 * that the response said "conflict".
 */
const RUN = `alimp-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
let seq = 0;
const uid = (label: string) => `${RUN}-${label}-${seq++}`;

const SECRET_KEY = `hsk_test_${RUN}`;

const { db, client } = createDatabase({
  url: process.env.DATABASE_URL as string,
});

const steam = fakeAccountLink({ id: "steam", name: "Steam" });
/** A `multiple:false` provider whose author chose the REPLACE policy. */
const singleRep = fakeAccountLink({
  id: "singlerep",
  name: "Single Replace",
  multiple: false,
  onConflict: "replace",
});

const container = createHogsendClient({
  accountLinks: { providers: [steam, singleRep] },
  overrides: { hatchet: engine.hatchet },
});
const app = createApp(container);

const hashKey = (raw: string) => createHash("sha256").update(raw).digest("hex");

let secretKeyId = "";
let endpointId = "";

beforeAll(async () => {
  const [sk] = await db
    .insert(apiKeys)
    .values({
      name: `${RUN} secret accounts`,
      keyPrefix: SECRET_KEY.slice(0, 8),
      keyHash: hashKey(SECRET_KEY),
      scopes: ["accounts"],
    })
    .returning({ id: apiKeys.id });
  secretKeyId = sk?.id ?? "";

  const [row] = await db
    .insert(webhookEndpoints)
    .values({
      url: `https://example.com/${RUN}/import-sink`,
      secret: "whsec_dGVzdHNlY3JldGZvcmVtaXRwb2ludGNvdmVyYWdldGVzdA==",
      secretPrefix: "whsec_dGVzd",
      eventTypes: ["account.linked", "account.unlinked"],
      disabled: false,
    })
    .returning({ id: webhookEndpoints.id });
  endpointId = row?.id ?? "";
});

afterAll(async () => {
  if (endpointId) {
    await db
      .delete(webhookEndpoints)
      .where(eq(webhookEndpoints.id, endpointId));
  }
  await db
    .delete(linkedAccounts)
    .where(like(linkedAccounts.providerUserId, `${RUN}%`));
  await db.delete(contacts).where(like(contacts.externalId, `${RUN}%`));
  await db.delete(contacts).where(like(contacts.email, `${RUN}%`));
  if (secretKeyId) await db.delete(apiKeys).where(eq(apiKeys.id, secretKeyId));
  await client.end();
});

async function makeContact(): Promise<string> {
  // `externalId` is never NULL: `afterAll` deletes by `LIKE '<RUN>%'`, and no
  // predicate can match a NULL column — an all-NULL contact is orphaned in the
  // shared test database forever.
  const [row] = await db
    .insert(contacts)
    .values({ externalId: uid("ext") })
    .returning({ id: contacts.id });
  if (!row) throw new Error("contact insert failed");
  return row.id;
}

function importRows(rows: Record<string, unknown>[]) {
  return app.request("/v1/accounts/import", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ rows }),
  });
}

/**
 * EVERY row for a pair, live and historical, oldest version first.
 *
 * Deliberately not filtered to `unlinkedAt IS NULL`: a takeover would
 * soft-unlink the owner's row and insert a new one, so the row COUNT is part
 * of the proof that nothing moved.
 */
const liveRow = (provider: string, providerUserId: string) =>
  db
    .select()
    .from(linkedAccounts)
    .where(
      and(
        eq(linkedAccounts.provider, provider),
        eq(linkedAccounts.providerUserId, providerUserId),
      ),
    )
    .orderBy(asc(linkedAccounts.version));

type Delivery = {
  eventType: string;
  dedupeKey: string | null;
  data: Record<string, unknown>;
};

async function deliveries(): Promise<Delivery[]> {
  const rows = await db
    .select({
      eventType: webhookDeliveries.eventType,
      dedupeKey: webhookDeliveries.dedupeKey,
      payload: webhookDeliveries.payload,
    })
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.endpointId, endpointId))
    .orderBy(asc(webhookDeliveries.createdAt));
  return rows.map((r) => ({
    eventType: r.eventType,
    dedupeKey: r.dedupeKey,
    data: (r.payload as { data: Record<string, unknown> }).data,
  }));
}

async function pairDeliveries(
  provider: string,
  providerUserId: string,
): Promise<Delivery[]> {
  const all = await deliveries();
  return all.filter((r) =>
    r.dedupeKey?.startsWith(`al:${provider}:${providerUserId}:`),
  );
}

/** The emits are fire-and-forget — poll until `expected` rows land. */
async function waitFor(
  read: () => Promise<Delivery[]>,
  expected: number,
  timeoutMs = 5000,
): Promise<Delivery[]> {
  const start = Date.now();
  let rows = await read();
  while (rows.length < expected && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 25));
    rows = await read();
  }
  return rows;
}

/** Absence cannot be polled for — give the emit a fixed window to not appear. */
const SETTLE_MS = 750;

async function countContacts(): Promise<number> {
  const rows = (await db.execute(
    sql`SELECT count(*)::int AS n FROM contacts`,
  )) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? -1;
}

describe("POST /v1/accounts/import inserts", () => {
  it("imports a link where no live owner exists, stamped method:import", async () => {
    const contactId = await makeContact();
    const providerUserId = uid("steamid");
    const historical = "2019-04-01T10:00:00.000Z";

    const res = await importRows([
      {
        provider: "steam",
        providerUserId,
        contactId,
        username: "old-timer",
        linkedAt: historical,
      },
    ]);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ inserted: 1, conflicts: [] });

    const [row] = await liveRow("steam", providerUserId);
    expect(row?.contactId).toBe(contactId);
    expect(row?.method).toBe("import");
    expect(row?.username).toBe("old-timer");
    // The customer's historical timestamp survives — that is the whole reason
    // an import exists rather than a re-authorization campaign.
    expect(row?.linkedAt.toISOString()).toBe(historical);
    expect(row?.unlinkedAt).toBeNull();
    // No proven grant, so nothing sealed.
    expect(row?.tokens).toBeNull();
  });

  it("stamps method:'import' and relink:false on the emitted account.linked", async () => {
    const contactId = await makeContact();
    const providerUserId = uid("steamid");

    await importRows([{ provider: "steam", providerUserId, contactId }]);

    const rows = await waitFor(
      () => pairDeliveries("steam", providerUserId),
      1,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventType).toBe("account.linked");
    expect(rows[0]?.dedupeKey).toBe(`al:steam:${providerUserId}:v1`);
    expect(rows[0]?.data.method).toBe("import");
    expect(rows[0]?.data.relink).toBe(false);
    expect(rows[0]?.data.version).toBe("1");
    expect(rows[0]?.data.contactId).toBe(contactId);
  });

  it("a partially conflicting batch still inserts the clean rows", async () => {
    const owner = await makeContact();
    const thief = await makeContact();
    const takenPair = uid("steamid");
    const cleanPairA = uid("steamid");
    const cleanPairB = uid("steamid");

    await db.insert(linkedAccounts).values({
      contactId: owner,
      provider: "steam",
      providerUserId: takenPair,
      method: "oauth",
      singleton: false,
      version: 4n,
    });

    const res = await importRows([
      { provider: "steam", providerUserId: cleanPairA, contactId: thief },
      { provider: "steam", providerUserId: takenPair, contactId: thief },
      { provider: "steam", providerUserId: cleanPairB, contactId: thief },
    ]);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      inserted: number;
      conflicts: Array<Record<string, unknown>>;
    };
    expect(body.inserted).toBe(2);
    expect(body.conflicts).toHaveLength(1);
    expect(body.conflicts[0]?.providerUserId).toBe(takenPair);
    expect((await liveRow("steam", cleanPairA))[0]?.contactId).toBe(thief);
    expect((await liveRow("steam", cleanPairB))[0]?.contactId).toBe(thief);
  });

  it("400s a batch over 1000 rows", async () => {
    const contactId = await makeContact();
    const rows = Array.from({ length: 1001 }, (_, i) => ({
      provider: "steam",
      providerUserId: `${RUN}-bulk-${i}`,
      contactId,
    }));
    const res = await importRows(rows);
    expect(res.status).toBe(400);
    // And nothing from the batch was applied.
    expect(await liveRow("steam", `${RUN}-bulk-0`)).toHaveLength(0);
  });
});

describe("POST /v1/accounts/import CANNOT steal a live link", () => {
  it("leaves the existing owner byte-identical and reports the conflict", async () => {
    const ownerA = await makeContact();
    const thiefB = await makeContact();
    const providerUserId = uid("steamid");

    const [seeded] = await db
      .insert(linkedAccounts)
      .values({
        contactId: ownerA,
        provider: "steam",
        providerUserId,
        username: "the-real-owner",
        method: "oauth",
        singleton: false,
        version: 7n,
      })
      .returning();

    const res = await importRows([
      {
        provider: "steam",
        providerUserId,
        contactId: thiefB,
        username: "the-thief",
      },
    ]);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      inserted: number;
      conflicts: Array<Record<string, unknown>>;
    };
    expect(body.inserted).toBe(0);
    expect(body.conflicts).toEqual([
      {
        provider: "steam",
        providerUserId,
        reason: "already_linked",
        ownerContactId: ownerA,
      },
    ]);

    // THE assertion: the row is untouched. Not "still owned by A" — the same
    // contact, the SAME VERSION (no version was allocated at all) and the same
    // `linkedAt`. A displaced-then-restored row would fail on the version.
    const rows = await liveRow("steam", providerUserId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.contactId).toBe(ownerA);
    expect(String(rows[0]?.version)).toBe("7");
    expect(rows[0]?.linkedAt.toISOString()).toBe(
      seeded?.linkedAt.toISOString(),
    );
    expect(rows[0]?.username).toBe("the-real-owner");
    expect(rows[0]?.unlinkedAt).toBeNull();

    // And NOTHING was announced: no `account.linked` for the thief, no
    // `account.unlinked` for the owner.
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    expect(await pairDeliveries("steam", providerUserId)).toEqual([]);
  });

  it("cannot steal even when the provider is multiple:false with onConflict:'replace'", async () => {
    // `replace` is a MOVE and a hosted-callback-only behavior. A provider whose
    // author chose it must NOT become an import-time takeover primitive.
    const contactId = await makeContact();
    const heldPair = uid("holds");
    const wantedPair = uid("wants");

    const [seeded] = await db
      .insert(linkedAccounts)
      .values({
        contactId,
        provider: "singlerep",
        providerUserId: heldPair,
        method: "oauth",
        singleton: true,
        version: 3n,
      })
      .returning();

    const res = await importRows([
      { provider: "singlerep", providerUserId: wantedPair, contactId },
    ]);

    const body = (await res.json()) as {
      inserted: number;
      conflicts: Array<Record<string, unknown>>;
    };
    expect(body.inserted).toBe(0);
    expect(body.conflicts[0]?.reason).toBe("singleton_conflict");

    // The held pair is untouched — not soft-unlinked to make room.
    const held = await liveRow("singlerep", heldPair);
    expect(held[0]?.unlinkedAt).toBeNull();
    expect(String(held[0]?.version)).toBe("3");
    expect(held[0]?.linkedAt.toISOString()).toBe(
      seeded?.linkedAt.toISOString(),
    );
    expect(await liveRow("singlerep", wantedPair)).toHaveLength(0);

    await new Promise((r) => setTimeout(r, SETTLE_MS));
    expect(await pairDeliveries("singlerep", heldPair)).toEqual([]);
    expect(await pairDeliveries("singlerep", wantedPair)).toEqual([]);
  });

  it("a re-import of the SAME contact's own pair allocates no new version", async () => {
    const contactId = await makeContact();
    const providerUserId = uid("steamid");

    await importRows([{ provider: "steam", providerUserId, contactId }]);
    await waitFor(() => pairDeliveries("steam", providerUserId), 1);

    const res = await importRows([
      { provider: "steam", providerUserId, contactId },
    ]);
    const body = (await res.json()) as {
      inserted: number;
      conflicts: unknown[];
    };
    // A conflict-free no-op: not an insert, not a conflict.
    expect(body.inserted).toBe(0);
    expect(body.conflicts).toEqual([]);

    const rows = await liveRow("steam", providerUserId);
    expect(rows).toHaveLength(1);
    expect(String(rows[0]?.version)).toBe("1");

    // And no second announcement — nothing transitioned.
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    expect(await pairDeliveries("steam", providerUserId)).toHaveLength(1);
  });

  it("an unknown contact is a conflict and mints no contact", async () => {
    const before = await countContacts();
    const providerUserId = uid("steamid");

    const res = await importRows([
      {
        provider: "steam",
        providerUserId,
        email: `${RUN}-never-existed@example.com`,
      },
    ]);

    const body = (await res.json()) as {
      inserted: number;
      conflicts: Array<Record<string, unknown>>;
    };
    expect(body.inserted).toBe(0);
    expect(body.conflicts).toEqual([
      { provider: "steam", providerUserId, reason: "unknown_contact" },
    ]);
    expect(await liveRow("steam", providerUserId)).toHaveLength(0);
    expect(await countContacts()).toBe(before);
  });
});
