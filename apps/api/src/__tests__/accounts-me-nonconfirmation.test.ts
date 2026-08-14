import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fakeAccountLink } from "./account-link-fakes.js";

// Same real test DB the engine singletons + the route container read.
process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// `GET /v1/accounts/me` writes nothing and emits nothing, but the container's
// construction still reaches the engine's hatchet singleton — mock it (the
// accounts-callback idiom) so no gRPC dial happens.
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

const { apiKeys, contacts, createDatabase, linkedAccounts } = await import(
  "@hogsend/db"
);
const { eq, like } = await import("drizzle-orm");
const {
  createApp,
  createHogsendClient,
  generateUserToken,
  serializePublicLinkedAccount,
} = await import("@hogsend/engine");

/**
 * PRD 09 T2 + T8 — `GET /v1/accounts/me` NEVER CONFIRMS EXISTENCE
 * (DECISIONS §6.9).
 *
 * Every token problem — absent, malformed, expired, badly signed, or naming a
 * userId with no contact — answers with the SAME status and the SAME body as
 * "this user exists and holds no links". The last test in this file asserts
 * that on `await res.text()` equality, which is the only form of the assertion
 * a future 403 arm cannot slip past.
 *
 * The serializer test is the structural half: `/me` returns four display keys,
 * asserted on the KEY SET, so adding a column to `linked_accounts` fails here
 * rather than leaking `providerUserId` to a browser.
 */
const RUN = `alme-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
let seq = 0;
const uid = (label: string) => `${RUN}-${label}-${seq++}`;

const SECRET = "test-secret-for-vitest-minimum-32-characters-long";
const ORIGIN = "https://play.example.com";
const PK_KEY = `pk_test_${RUN}`;

const { db, client } = createDatabase({
  url: process.env.DATABASE_URL as string,
});

const steam = fakeAccountLink({ id: "steam", name: "Steam" });
const container = createHogsendClient({
  accountLinks: { providers: [steam], allowedOrigins: [ORIGIN] },
});
const app = createApp(container);

const hashKey = (raw: string) => createHash("sha256").update(raw).digest("hex");

let pkKeyId = "";
/** The player who owns a link. */
let playerUserId = "";
/** A REAL contact that exists and holds NO links. */
let linklessUserId = "";

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

  playerUserId = uid("player");
  linklessUserId = uid("linkless");
  const [player] = await db
    .insert(contacts)
    .values({ externalId: playerUserId, email: `${playerUserId}@example.com` })
    .returning({ id: contacts.id });
  await db
    .insert(contacts)
    .values({ externalId: linklessUserId })
    .returning({ id: contacts.id });

  await db.insert(linkedAccounts).values({
    contactId: player?.id as string,
    provider: "steam",
    providerUserId: uid("steamid"),
    username: "display-handle",
    avatarUrl: "https://avatars.example/steam.png",
    verifiedEmail: `${RUN}-provider@steam.example`,
    method: "oauth",
    singleton: true,
    version: 1n,
  });
});

afterAll(async () => {
  await db
    .delete(linkedAccounts)
    .where(like(linkedAccounts.providerUserId, `${RUN}%`));
  await db.delete(contacts).where(like(contacts.externalId, `${RUN}%`));
  if (pkKeyId) await db.delete(apiKeys).where(eq(apiKeys.id, pkKeyId));
  await client.end();
});

function me(query: string) {
  return app.request(`/v1/accounts/me${query}`, {
    headers: { Authorization: `Bearer ${PK_KEY}`, Origin: ORIGIN },
  });
}

const tokenFor = (userId: string) =>
  generateUserToken({ secret: SECRET, userId });

// ---------------------------------------------------------------------------
// T2 — the serializer is the structural guarantee
// ---------------------------------------------------------------------------

describe("serializePublicLinkedAccount", () => {
  it("emits exactly four keys, whatever the row carries", () => {
    // A FULLY POPULATED row: every field the operator shape may return, plus
    // the ones that must never leave the engine. If a future column is added
    // and the serializer starts spreading the row, this fails here rather than
    // leaking to a browser.
    const serialized = serializePublicLinkedAccount({
      id: "row-uuid",
      contactId: "contact-uuid",
      provider: "steam",
      providerUserId: "76561198000000000",
      username: "gaben",
      verifiedEmail: "provider-reported@steam.example",
      avatarUrl: "https://avatars.example/steam.png",
      method: "oauth",
      singleton: true,
      version: "9007199254740995",
      linkedAt: new Date("2026-08-14T12:00:00.000Z"),
      unlinkedAt: null,
      unlinkReason: null,
      tokensRevokedAt: new Date("2026-08-14T13:00:00.000Z"),
      hasTokens: true,
    });

    expect(Object.keys(serialized).sort()).toEqual([
      "avatarUrl",
      "linkedAt",
      "provider",
      "username",
    ]);
  });
});

// ---------------------------------------------------------------------------
// T8 — the route
// ---------------------------------------------------------------------------

describe("GET /v1/accounts/me", () => {
  it("returns display fields only for a valid token", async () => {
    const res = await me(
      `?userToken=${encodeURIComponent(tokenFor(playerUserId))}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      accounts: Array<Record<string, unknown>>;
    };
    expect(body.accounts).toHaveLength(1);
    const account = body.accounts[0] as Record<string, unknown>;
    expect(account.provider).toBe("steam");
    expect(account.username).toBe("display-handle");
    expect(account.avatarUrl).toBe("https://avatars.example/steam.png");
    expect(typeof account.linkedAt).toBe("string");
  });

  it("never returns providerUserId, contactId, version or any other internal", async () => {
    const res = await me(
      `?userToken=${encodeURIComponent(tokenFor(playerUserId))}`,
    );
    const body = (await res.json()) as {
      accounts: Array<Record<string, unknown>>;
    };
    // Asserted on the PARSED KEY SET, not on a sample field: the point is that
    // nothing else can be present at all.
    expect(Object.keys(body.accounts[0] as object).sort()).toEqual([
      "avatarUrl",
      "linkedAt",
      "provider",
      "username",
    ]);
    // And belt-and-braces on the raw text, in case a key is added with an
    // undefined value that JSON.stringify would have dropped from the object
    // above but a nested structure would still carry.
    const raw = JSON.stringify(body);
    for (const forbidden of [
      "providerUserId",
      "contactId",
      "version",
      "method",
      "tokens",
      "tokensRevokedAt",
      "email",
    ]) {
      expect(raw).not.toContain(forbidden);
    }
  });

  it("does not leak under an unexpected query parameter", async () => {
    const res = await me(
      `?userToken=${encodeURIComponent(tokenFor(playerUserId))}&include=all&fields=*&expand=contact`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      accounts: Array<Record<string, unknown>>;
    };
    expect(Object.keys(body.accounts[0] as object).sort()).toEqual([
      "avatarUrl",
      "linkedAt",
      "provider",
      "username",
    ]);
  });

  it("an absent token returns 200 with an empty list", async () => {
    const res = await me("");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accounts: [] });
  });

  it("a malformed token returns 200 with an empty list", async () => {
    const res = await me("?userToken=not-a-token");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accounts: [] });
  });

  it("an expired token returns 200 with an empty list", async () => {
    const expired = generateUserToken({
      secret: SECRET,
      userId: playerUserId,
      expiresInSeconds: -60,
    });
    const res = await me(`?userToken=${encodeURIComponent(expired)}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accounts: [] });
  });

  it("a forged token (valid payload, wrong secret) returns 200 with an empty list", async () => {
    const forged = generateUserToken({
      secret: "an-entirely-different-secret-at-least-32-chars",
      userId: playerUserId,
    });
    const res = await me(`?userToken=${encodeURIComponent(forged)}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accounts: [] });
  });

  it("a token for a nonexistent user returns 200 with an empty list", async () => {
    const res = await me(
      `?userToken=${encodeURIComponent(tokenFor(uid("ghost")))}`,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accounts: [] });
  });

  it("a forged token and a real link-less user return byte-identical bodies", async () => {
    // THE non-confirmation property (DECISIONS §6.9). A forged token names the
    // player who DOES hold a link; the valid one names a contact that exists
    // and holds none. If the two answers differ in any byte — status, body,
    // an error field — a caller can enumerate.
    const forged = generateUserToken({
      secret: "an-entirely-different-secret-at-least-32-chars",
      userId: playerUserId,
    });
    const forgedRes = await me(`?userToken=${encodeURIComponent(forged)}`);
    const realRes = await me(
      `?userToken=${encodeURIComponent(tokenFor(linklessUserId))}`,
    );

    expect(forgedRes.status).toBe(realRes.status);
    expect(await forgedRes.text()).toBe(await realRes.text());
  });
});
