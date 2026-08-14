import { createHash } from "node:crypto";
import type { AfterUnlinkContext } from "@hogsend/core";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
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
const { and, asc, eq, isNull, like } = await import("drizzle-orm");
const engine = await import("@hogsend/engine");
const { createApp, createHogsendClient } = engine;

/**
 * PRD 09 T1/T3/T4 — the OPERATOR pull plane.
 *
 * `GET /v1/accounts` (list), `GET /v1/accounts/{provider}/{providerUserId}`
 * (reverse lookup) and the `DELETE` beside it, plus the `accounts` scope that
 * gates all three.
 *
 * Two invariants get structural assertions rather than sampled ones:
 * `version` is a decimal STRING at every boundary (a bigint above
 * `Number.MAX_SAFE_INTEGER` round-trips intact), and the sealed `tokens` blob
 * never appears in any response under any filter.
 */
const RUN = `aldp-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
let seq = 0;
const uid = (label: string) => `${RUN}-${label}-${seq++}`;

const ACCOUNTS_KEY = `hsk_test_${RUN}_accounts`;
const ADMIN_KEY = `hsk_test_${RUN}_admin`;
const INGEST_KEY = `hsk_test_${RUN}_ingest`;

const { db, client } = createDatabase({
  url: process.env.DATABASE_URL as string,
});

const steam = fakeAccountLink({ id: "steam", name: "Steam" });
const afterUnlinkCalls: AfterUnlinkContext[] = [];
const container = createHogsendClient({
  accountLinks: {
    providers: [steam],
    hooks: {
      afterUnlink(ctx) {
        afterUnlinkCalls.push(ctx);
      },
    },
  },
  overrides: { hatchet: engine.hatchet },
});
const app = createApp(container);

const hashKey = (raw: string) => createHash("sha256").update(raw).digest("hex");

const keyIds: string[] = [];
let endpointId = "";
let contactId = "";
let otherContactId = "";
const EXTERNAL = `${RUN}-player`;
const EMAIL = `${RUN}-player@example.com`;

beforeAll(async () => {
  for (const [name, raw, scopes] of [
    ["accounts", ACCOUNTS_KEY, ["accounts"]],
    ["admin", ADMIN_KEY, ["full-admin"]],
    ["ingest", INGEST_KEY, ["ingest"]],
  ] as const) {
    const [row] = await db
      .insert(apiKeys)
      .values({
        name: `${RUN} ${name}`,
        keyPrefix: raw.slice(0, 8),
        keyHash: hashKey(raw),
        scopes: [...scopes],
      })
      .returning({ id: apiKeys.id });
    if (row) keyIds.push(row.id);
  }

  const [ep] = await db
    .insert(webhookEndpoints)
    .values({
      url: `https://example.com/${RUN}/dataplane-sink`,
      secret: "whsec_dGVzdHNlY3JldGZvcmVtaXRwb2ludGNvdmVyYWdldGVzdA==",
      secretPrefix: "whsec_dGVzd",
      eventTypes: ["account.linked", "account.unlinked"],
      disabled: false,
    })
    .returning({ id: webhookEndpoints.id });
  endpointId = ep?.id ?? "";

  const [c1] = await db
    .insert(contacts)
    .values({ externalId: EXTERNAL, email: EMAIL })
    .returning({ id: contacts.id });
  contactId = c1?.id ?? "";
  const [c2] = await db
    .insert(contacts)
    .values({ externalId: `${RUN}-other` })
    .returning({ id: contacts.id });
  otherContactId = c2?.id ?? "";
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
  for (const id of keyIds) await db.delete(apiKeys).where(eq(apiKeys.id, id));
  await client.end();
});

beforeEach(() => {
  afterUnlinkCalls.length = 0;
});

async function seedLink(over: {
  contactId?: string;
  provider?: string;
  providerUserId?: string;
  version?: bigint;
  tokensRevokedAt?: Date;
  unlinkedAt?: Date;
}): Promise<string> {
  const providerUserId = over.providerUserId ?? uid("steamid");
  await db.insert(linkedAccounts).values({
    contactId: over.contactId ?? contactId,
    provider: over.provider ?? "steam",
    providerUserId,
    username: "handle",
    method: "oauth",
    singleton: false,
    version: over.version ?? 1n,
    tokens: "sealed-blob-that-must-never-leave-the-engine",
    ...(over.tokensRevokedAt ? { tokensRevokedAt: over.tokensRevokedAt } : {}),
    ...(over.unlinkedAt
      ? { unlinkedAt: over.unlinkedAt, unlinkReason: "api" }
      : {}),
  });
  return providerUserId;
}

const authed = (key = ACCOUNTS_KEY) => ({ Authorization: `Bearer ${key}` });

type Delivery = {
  eventType: string;
  dedupeKey: string | null;
  data: Record<string, unknown>;
};

async function pairDeliveries(providerUserId: string): Promise<Delivery[]> {
  const rows = await db
    .select({
      eventType: webhookDeliveries.eventType,
      dedupeKey: webhookDeliveries.dedupeKey,
      payload: webhookDeliveries.payload,
    })
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.endpointId, endpointId))
    .orderBy(asc(webhookDeliveries.createdAt));
  return rows
    .map((r) => ({
      eventType: r.eventType,
      dedupeKey: r.dedupeKey,
      data: (r.payload as { data: Record<string, unknown> }).data,
    }))
    .filter((r) => r.dedupeKey?.startsWith(`al:steam:${providerUserId}:`));
}

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

const SETTLE_MS = 750;

// ---------------------------------------------------------------------------
// T1 — the `accounts` scope
// ---------------------------------------------------------------------------

describe("the accounts scope", () => {
  it("rejects no key with 401 and reads nothing", async () => {
    const res = await app.request("/v1/accounts?provider=steam");
    expect(res.status).toBe(401);
  });

  it("rejects a key without the accounts scope with 403", async () => {
    const res = await app.request("/v1/accounts?provider=steam", {
      headers: authed(INGEST_KEY),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "Forbidden: insufficient scope",
    });
  });

  it("accepts a key granted accounts explicitly", async () => {
    const res = await app.request("/v1/accounts?provider=steam", {
      headers: authed(),
    });
    expect(res.status).toBe(200);
  });

  it("accepts a full-admin key (the orthogonal arm of hasScope)", async () => {
    const res = await app.request("/v1/accounts?provider=steam", {
      headers: authed(ADMIN_KEY),
    });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// T3 — list + reverse lookup
// ---------------------------------------------------------------------------

describe("GET /v1/accounts", () => {
  it("lists live links by contactId", async () => {
    const puid = await seedLink({});
    const res = await app.request(`/v1/accounts?contactId=${contactId}`, {
      headers: authed(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      accounts: Array<Record<string, unknown>>;
    };
    expect(body.accounts.some((a) => a.providerUserId === puid)).toBe(true);
    expect(body.accounts.every((a) => a.contactId === contactId)).toBe(true);
  });

  it("lists live links by email", async () => {
    const puid = await seedLink({});
    const res = await app.request(
      `/v1/accounts?email=${encodeURIComponent(EMAIL)}`,
      { headers: authed() },
    );
    const body = (await res.json()) as {
      accounts: Array<Record<string, unknown>>;
    };
    expect(body.accounts.some((a) => a.providerUserId === puid)).toBe(true);
  });

  it("returns an EMPTY list for an email nobody owns, never an unfiltered one", async () => {
    await seedLink({});
    const res = await app.request(
      `/v1/accounts?email=${RUN}-nobody@example.com`,
      { headers: authed() },
    );
    expect(await res.json()).toEqual({ accounts: [] });
  });

  it("lists by provider with limit and offset", async () => {
    const own = `${RUN}-page`;
    await seedLink({ contactId: otherContactId, providerUserId: `${own}-1` });
    await seedLink({ contactId: otherContactId, providerUserId: `${own}-2` });
    await seedLink({ contactId: otherContactId, providerUserId: `${own}-3` });

    const first = await app.request(
      `/v1/accounts?contactId=${otherContactId}&provider=steam&limit=2`,
      { headers: authed() },
    );
    const firstBody = (await first.json()) as { accounts: unknown[] };
    expect(firstBody.accounts).toHaveLength(2);

    const second = await app.request(
      `/v1/accounts?contactId=${otherContactId}&provider=steam&limit=2&offset=2`,
      { headers: authed() },
    );
    const secondBody = (await second.json()) as {
      accounts: Array<Record<string, unknown>>;
    };
    expect(secondBody.accounts).toHaveLength(1);
  });

  it("400s when no filter is supplied", async () => {
    const res = await app.request("/v1/accounts", { headers: authed() });
    expect(res.status).toBe(400);
  });

  it("returns tokensRevokedAt but NEVER the sealed tokens blob", async () => {
    const revokedAt = new Date("2026-01-02T03:04:05.000Z");
    const puid = await seedLink({ tokensRevokedAt: revokedAt });
    const res = await app.request(
      `/v1/accounts?contactId=${contactId}&provider=steam`,
      { headers: authed() },
    );
    const raw = await res.text();
    expect(raw).not.toContain("sealed-blob");
    expect(raw).not.toContain('tokens":');
    const body = JSON.parse(raw) as {
      accounts: Array<Record<string, unknown>>;
    };
    const row = body.accounts.find((a) => a.providerUserId === puid);
    expect(row?.tokensRevokedAt).toBe(revokedAt.toISOString());
  });
});

describe("GET /v1/accounts/{provider}/{providerUserId}", () => {
  it("returns the owning contactId and version", async () => {
    const puid = await seedLink({ version: 5n });
    const res = await app.request(`/v1/accounts/steam/${puid}`, {
      headers: authed(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { account: Record<string, unknown> };
    expect(body.account.contactId).toBe(contactId);
    expect(body.account.version).toBe("5");
    expect(body.account.method).toBe("oauth");
    expect(typeof body.account.linkedAt).toBe("string");
  });

  it("returns a version above Number.MAX_SAFE_INTEGER intact, as a string", async () => {
    // 9007199254740993 = 2^53 + 1. Through a JS number it becomes
    // 9007199254740992 — the consumer's `incoming.version > stored.version`
    // guard then silently compares the wrong value.
    const puid = await seedLink({ version: 9007199254740993n });
    const res = await app.request(`/v1/accounts/steam/${puid}`, {
      headers: authed(),
    });
    const raw = await res.text();
    expect(raw).toContain('"version":"9007199254740993"');
    const body = JSON.parse(raw) as { account: { version: string } };
    expect(body.account.version).toBe("9007199254740993");
  });

  it("404s an unknown pair", async () => {
    const res = await app.request(`/v1/accounts/steam/${RUN}-nobody`, {
      headers: authed(),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toHaveProperty("error");
  });

  it("404s an UNLINKED pair — history is not a live owner", async () => {
    const puid = await seedLink({ unlinkedAt: new Date() });
    const res = await app.request(`/v1/accounts/steam/${puid}`, {
      headers: authed(),
    });
    expect(res.status).toBe(404);
  });

  it("matches a providerUserId carrying reserved URL characters", async () => {
    const puid = await seedLink({ providerUserId: `${RUN}-a+b c/d` });
    const res = await app.request(
      `/v1/accounts/steam/${encodeURIComponent(puid)}`,
      { headers: authed() },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { account: { providerUserId: string } };
    expect(body.account.providerUserId).toBe(puid);
  });
});

// ---------------------------------------------------------------------------
// T4 — the operator unlink
// ---------------------------------------------------------------------------

describe("DELETE /v1/accounts/{provider}/{providerUserId}", () => {
  it("unlinks a live link and returns the new version as a string", async () => {
    const puid = await seedLink({ version: 41n });
    const res = await app.request(`/v1/accounts/steam/${puid}`, {
      method: "DELETE",
      headers: authed(),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ unlinked: true, version: "42" });

    const live = await db
      .select()
      .from(linkedAccounts)
      .where(
        and(
          eq(linkedAccounts.providerUserId, puid),
          isNull(linkedAccounts.unlinkedAt),
        ),
      );
    expect(live).toHaveLength(0);
  });

  it("stamps reason 'api' and calls afterUnlink EXACTLY ONCE, from the store", async () => {
    const puid = await seedLink({});
    await app.request(`/v1/accounts/steam/${puid}`, {
      method: "DELETE",
      headers: authed(),
    });

    const [row] = await db
      .select()
      .from(linkedAccounts)
      .where(eq(linkedAccounts.providerUserId, puid));
    expect(row?.unlinkReason).toBe("api");

    // The STORE is the sole invoker (DECISIONS §15.4). A route that also
    // invoked the hook would fire it twice, and the hooks being documented
    // at-least-once means nothing would fail loudly.
    const mine = afterUnlinkCalls.filter((c) => c.providerUserId === puid);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.reason).toBe("api");
  });

  it("emits exactly one account.unlinked with a versioned dedupeKey", async () => {
    const puid = await seedLink({ version: 2n });
    await app.request(`/v1/accounts/steam/${puid}`, {
      method: "DELETE",
      headers: authed(),
    });

    const rows = await waitFor(() => pairDeliveries(puid), 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventType).toBe("account.unlinked");
    expect(rows[0]?.dedupeKey).toBe(`al:steam:${puid}:v3`);
    expect(rows[0]?.data.reason).toBe("api");
    expect(rows[0]?.data.version).toBe("3");
    expect(rows[0]?.data.state).toBe("unlinked");
    expect(rows[0]?.data.contactId).toBe(contactId);
    // FULL CURRENT STATE: the contact's own identity, from the store's
    // in-transaction join.
    expect(rows[0]?.data.userId).toBe(EXTERNAL);
    expect(rows[0]?.data.email).toBe(EMAIL);
  });

  it("returns unlinked:false for an unknown pair and emits nothing", async () => {
    const puid = `${RUN}-ghost`;
    const res = await app.request(`/v1/accounts/steam/${puid}`, {
      method: "DELETE",
      headers: authed(),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ unlinked: false });

    await new Promise((r) => setTimeout(r, SETTLE_MS));
    expect(await pairDeliveries(puid)).toEqual([]);
    expect(afterUnlinkCalls.filter((c) => c.providerUserId === puid)).toEqual(
      [],
    );
  });

  it("a repeated DELETE emits nothing the second time", async () => {
    const puid = await seedLink({});
    const first = await app.request(`/v1/accounts/steam/${puid}`, {
      method: "DELETE",
      headers: authed(),
    });
    expect((await first.json()) as unknown).toEqual({
      unlinked: true,
      version: "2",
    });
    await waitFor(() => pairDeliveries(puid), 1);

    const second = await app.request(`/v1/accounts/steam/${puid}`, {
      method: "DELETE",
      headers: authed(),
    });
    expect(await second.json()).toEqual({ unlinked: false });

    await new Promise((r) => setTimeout(r, SETTLE_MS));
    expect(await pairDeliveries(puid)).toHaveLength(1);
  });
});
