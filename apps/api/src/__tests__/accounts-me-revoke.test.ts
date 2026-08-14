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
const { createApp, createHogsendClient, generateUserToken, linkAccount } =
  engine;

/**
 * PRD 09 T8b — `POST /v1/accounts/me/revoke`, THE PRIMARY PLAYER UNLINK
 * (DECISIONS §14).
 *
 * The publisher's site already knows the signed-in player and already mints a
 * `userToken` for the rest of the SDK, so the in-app path needs no email, no
 * hosted page and no token in a URL. Without this route the only revoke
 * surfaces would be a secret-key `DELETE` (a server call the player cannot
 * make) and an emailed link (which a Steam-only player can never receive).
 *
 * Three properties are asserted structurally:
 *  - ownership comes from the TOKEN (a body naming an identity is a 403, and a
 *    token for contact A can never touch contact B's link),
 *  - it is NON-CONFIRMING (every token problem is `200 { revoked: 0 }`),
 *  - `expectContactId` is passed on EVERY per-row call, so a hosted callback
 *    relinking the pair mid-revoke cannot have the new owner's just-proven
 *    link destroyed by the old owner's revoke.
 */
const RUN = `alrev-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
let seq = 0;
const uid = (label: string) => `${RUN}-${label}-${seq++}`;

const SECRET = "test-secret-for-vitest-minimum-32-characters-long";
const ORIGIN = "https://play.example.com";
const PK_KEY = `pk_test_${RUN}`;

const { db, client } = createDatabase({
  url: process.env.DATABASE_URL as string,
});

const steam = fakeAccountLink({ id: "steam", name: "Steam" });
/** `multiple: true` by default — a contact may hold many pairs here. */
const twitch = fakeAccountLink({ id: "twitch", name: "Twitch" });

const afterUnlinkCalls: AfterUnlinkContext[] = [];
/**
 * A mutable post-commit hook holder (the accounts-callback idiom — one
 * container per file, many hook postures).
 *
 * The racing-relink test uses it as a DETERMINISTIC interleaving point: the
 * store invokes `afterUnlink` post-commit, in the middle of the revoke's loop,
 * so a hook that performs the displacing link parks the revoke exactly where
 * the hazard lives. A sleep-based race cannot do this — measured: it passes
 * with AND without the `expectContactId` guard, because the enumeration and
 * the displacement land in an unpredictable order.
 */
const hooks: { onAfterUnlink?: (ctx: AfterUnlinkContext) => Promise<void> } =
  {};
const container = createHogsendClient({
  accountLinks: {
    providers: [steam, twitch],
    allowedOrigins: [ORIGIN],
    hooks: {
      async afterUnlink(ctx) {
        afterUnlinkCalls.push(ctx);
        await hooks.onAfterUnlink?.(ctx);
      },
    },
  },
  overrides: { hatchet: engine.hatchet },
});
const app = createApp(container);

const hashKey = (raw: string) => createHash("sha256").update(raw).digest("hex");

let pkKeyId = "";
let endpointId = "";
let contactA = "";
let contactB = "";
const PLAYER_A = `${RUN}-player-a`;
const PLAYER_B = `${RUN}-player-b`;

beforeAll(async () => {
  const [pk] = await db
    .insert(apiKeys)
    .values({
      name: `${RUN} publishable`,
      keyPrefix: PK_KEY.slice(0, 8),
      keyHash: hashKey(PK_KEY),
      scopes: ["ingest-public"],
      allowedOrigins: [ORIGIN],
    })
    .returning({ id: apiKeys.id });
  pkKeyId = pk?.id ?? "";

  const [ep] = await db
    .insert(webhookEndpoints)
    .values({
      url: `https://example.com/${RUN}/revoke-sink`,
      secret: "whsec_dGVzdHNlY3JldGZvcmVtaXRwb2ludGNvdmVyYWdldGVzdA==",
      secretPrefix: "whsec_dGVzd",
      eventTypes: ["account.linked", "account.unlinked"],
      disabled: false,
    })
    .returning({ id: webhookEndpoints.id });
  endpointId = ep?.id ?? "";

  const [a] = await db
    .insert(contacts)
    .values({ externalId: PLAYER_A, email: `${PLAYER_A}@example.com` })
    .returning({ id: contacts.id });
  contactA = a?.id ?? "";
  const [b] = await db
    .insert(contacts)
    .values({ externalId: PLAYER_B, email: `${PLAYER_B}@example.com` })
    .returning({ id: contacts.id });
  contactB = b?.id ?? "";
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
  if (pkKeyId) await db.delete(apiKeys).where(eq(apiKeys.id, pkKeyId));
  await client.end();
});

beforeEach(() => {
  afterUnlinkCalls.length = 0;
  hooks.onAfterUnlink = undefined;
});

const token = (userId: string, expiresInSeconds?: number) =>
  generateUserToken({
    secret: SECRET,
    userId,
    ...(expiresInSeconds !== undefined ? { expiresInSeconds } : {}),
  });

function revoke(body: Record<string, unknown>) {
  return app.request("/v1/accounts/me/revoke", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${PK_KEY}`,
      Origin: ORIGIN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function seedLink(over: {
  contactId: string;
  provider?: string;
  providerUserId?: string;
  version?: bigint;
  linkedAt?: Date;
}): Promise<string> {
  const providerUserId = over.providerUserId ?? uid("puid");
  await db.insert(linkedAccounts).values({
    contactId: over.contactId,
    provider: over.provider ?? "steam",
    providerUserId,
    method: "oauth",
    singleton: false,
    version: over.version ?? 1n,
    ...(over.linkedAt ? { linkedAt: over.linkedAt } : {}),
  });
  return providerUserId;
}

const rowsFor = (providerUserId: string) =>
  db
    .select()
    .from(linkedAccounts)
    .where(eq(linkedAccounts.providerUserId, providerUserId))
    .orderBy(asc(linkedAccounts.version));

const liveFor = (providerUserId: string) =>
  db
    .select()
    .from(linkedAccounts)
    .where(
      and(
        eq(linkedAccounts.providerUserId, providerUserId),
        isNull(linkedAccounts.unlinkedAt),
      ),
    );

type Delivery = {
  eventType: string;
  dedupeKey: string | null;
  data: Record<string, unknown>;
};

async function pairDeliveries(
  provider: string,
  providerUserId: string,
): Promise<Delivery[]> {
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
    .filter((r) =>
      r.dedupeKey?.startsWith(`al:${provider}:${providerUserId}:`),
    );
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

describe("POST /v1/accounts/me/revoke", () => {
  it("revokes the token contact's live link and emits account.unlinked with reason 'player'", async () => {
    const puid = await seedLink({ contactId: contactA, version: 6n });

    const res = await revoke({ provider: "steam", userToken: token(PLAYER_A) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: 1 });

    expect(await liveFor(puid)).toHaveLength(0);
    const [row] = await rowsFor(puid);
    expect(row?.unlinkReason).toBe("player");

    const deliveries = await waitFor(() => pairDeliveries("steam", puid), 1);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.eventType).toBe("account.unlinked");
    expect(deliveries[0]?.dedupeKey).toBe(`al:steam:${puid}:v7`);
    expect(deliveries[0]?.data).toMatchObject({
      state: "unlinked",
      provider: "steam",
      providerUserId: puid,
      contactId: contactA,
      userId: PLAYER_A,
      email: `${PLAYER_A}@example.com`,
      reason: "player",
      version: "7",
    });

    // `afterUnlink` fires ONCE, from the store (DECISIONS §15.4).
    expect(
      afterUnlinkCalls.filter((c) => c.providerUserId === puid),
    ).toHaveLength(1);
  });

  it("a second call revokes nothing and emits nothing", async () => {
    const puid = await seedLink({ contactId: contactA });
    await revoke({ provider: "steam", userToken: token(PLAYER_A) });
    await waitFor(() => pairDeliveries("steam", puid), 1);

    afterUnlinkCalls.length = 0;
    const res = await revoke({ provider: "steam", userToken: token(PLAYER_A) });
    expect(await res.json()).toEqual({ revoked: 0 });

    await new Promise((r) => setTimeout(r, SETTLE_MS));
    expect(await pairDeliveries("steam", puid)).toHaveLength(1);
    expect(afterUnlinkCalls).toEqual([]);
  });

  it("cannot revoke another contact's link", async () => {
    const mine = await seedLink({ contactId: contactA });
    const theirs = await seedLink({ contactId: contactB, version: 9n });

    const res = await revoke({ provider: "steam", userToken: token(PLAYER_A) });
    expect(res.status).toBe(200);
    // Only A's own link.
    expect((await res.json()) as unknown).toEqual({ revoked: 1 });
    expect(await liveFor(mine)).toHaveLength(0);

    const [theirRow] = await rowsFor(theirs);
    expect(theirRow?.unlinkedAt).toBeNull();
    expect(String(theirRow?.version)).toBe("9");

    await new Promise((r) => setTimeout(r, SETTLE_MS));
    expect(await pairDeliveries("steam", theirs)).toEqual([]);
  });

  it("revokes every live link for a multiple:true provider, one event per row", async () => {
    const a = await seedLink({ contactId: contactA, provider: "twitch" });
    const b = await seedLink({ contactId: contactA, provider: "twitch" });
    const c = await seedLink({ contactId: contactA, provider: "twitch" });
    // A different provider's link is untouched — the route is keyed on
    // `provider`, deliberately, since `/me` returns no id to send.
    const other = await seedLink({ contactId: contactA, provider: "steam" });

    const res = await revoke({
      provider: "twitch",
      userToken: token(PLAYER_A),
    });
    expect(await res.json()).toEqual({ revoked: 3 });

    for (const puid of [a, b, c]) {
      expect(await liveFor(puid)).toHaveLength(0);
      const rows = await waitFor(() => pairDeliveries("twitch", puid), 1);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.data.reason).toBe("player");
    }
    expect(await liveFor(other)).toHaveLength(1);
  });

  it("a forged token returns 200 { revoked: 0 } and mutates nothing", async () => {
    const puid = await seedLink({ contactId: contactA });
    const forged = generateUserToken({
      secret: "an-entirely-different-secret-at-least-32-chars",
      userId: PLAYER_A,
    });

    const res = await revoke({ provider: "steam", userToken: forged });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: 0 });
    expect(await liveFor(puid)).toHaveLength(1);
  });

  it("an absent, expired or unknown-user token is the SAME 200 { revoked: 0 }", async () => {
    const bodies = [
      { provider: "steam" },
      { provider: "steam", userToken: "not-a-token" },
      { provider: "steam", userToken: token(PLAYER_A, -60) },
      { provider: "steam", userToken: token(`${RUN}-nobody`) },
    ];
    for (const body of bodies) {
      const res = await revoke(body);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(JSON.stringify({ revoked: 0 }));
    }
  });

  it("a body carrying contactId or email is 403 and mutates nothing", async () => {
    const puid = await seedLink({ contactId: contactA });

    const withContact = await revoke({
      provider: "steam",
      userToken: token(PLAYER_A),
      contactId: contactB,
    });
    expect(withContact.status).toBe(403);

    const withEmail = await revoke({
      provider: "steam",
      userToken: token(PLAYER_A),
      email: `${PLAYER_B}@example.com`,
    });
    expect(withEmail.status).toBe(403);

    const withUserId = await revoke({
      provider: "steam",
      userToken: token(PLAYER_A),
      userId: PLAYER_B,
    });
    expect(withUserId.status).toBe(403);

    expect(await liveFor(puid)).toHaveLength(1);
  });
});

describe("a revoke racing a relink", () => {
  it("never unlinks the new owner's link (the expectContactId guard)", async () => {
    // The enumeration that finds a player's rows runs OUTSIDE the pair lock. A
    // hosted callback can relink a pair in the window between that read and
    // the write, and without `expectContactId` contact A's revoke then
    // destroys contact B's just-proven link.
    //
    // The interleaving is FORCED, not raced: the store invokes `afterUnlink`
    // post-commit, so a hook that performs the displacing link runs in the
    // middle of the revoke's loop — after it enumerated the contested pair as
    // contact A's, before it reaches it. Measured: a sleep-based race passes
    // with AND without the guard (the enumeration and the displacement land in
    // an unpredictable order), which would make this test vacuous.
    const contested = await seedLink({
      contactId: contactA,
      provider: "twitch",
      linkedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const blocker = await seedLink({
      contactId: contactA,
      provider: "twitch",
      // NEWER, so the revoke's newest-first enumeration reaches it FIRST.
      linkedAt: new Date("2026-06-01T00:00:00.000Z"),
    });

    let displaced: Awaited<ReturnType<typeof linkAccount>> | undefined;
    hooks.onAfterUnlink = async (ctx) => {
      if (ctx.providerUserId !== blocker || displaced) return;
      // A separate pool from the container's — a genuinely concurrent
      // connection, exactly like a hosted callback would be.
      displaced = await linkAccount({
        db,
        provider: "twitch",
        identity: { providerUserId: contested, username: "new-owner" },
        contactId: contactB,
        method: "oauth",
        multiple: true,
        onConflict: "reject",
        storeTokens: false,
        // Only a completed hosted callback may displace a live owner.
        allowDisplaceLiveOwner: true,
      });
    };

    const res = await revoke({
      provider: "twitch",
      userToken: token(PLAYER_A),
    });
    expect(res.status).toBe(200);
    // The displacement really did happen mid-revoke, and it MOVED a live link
    // (`relinked`, not a fresh `linked`) — otherwise there was no race to win.
    expect(displaced?.status).toBe("relinked");

    // THE INVARIANT: contact B's link for the contested pair is LIVE. The old
    // owner's revoke unlinked its own blocker row and left the new owner's
    // just-proven link alone.
    const live = await liveFor(contested);
    expect(live).toHaveLength(1);
    expect(live[0]?.contactId).toBe(contactB);
    expect(await liveFor(blocker)).toHaveLength(0);
    // The `not_owner` rejection is simply not counted — never a 403, never a
    // 404, and the response is the ordinary non-confirming shape.
    expect(await res.json()).toEqual({ revoked: 1 });
  });
});
