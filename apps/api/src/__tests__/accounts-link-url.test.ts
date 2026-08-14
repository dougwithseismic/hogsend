import { createHash } from "node:crypto";
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

/**
 * The mint throttle reads `getRedisIfConnected()`. A FAKE keeps this file
 * deterministic (no dependency on whether the dev Redis happens to be up) and
 * makes the 429 arms reachable at all: `null` is the fail-closed arm and a
 * throwing client is the "Redis fell over mid-request" arm.
 */
const { redisState } = vi.hoisted(() => ({
  redisState: {
    counts: new Map<string, number>(),
    mode: "ok" as "ok" | "down" | "throws",
  },
}));

vi.mock("../../../../packages/engine/src/lib/redis.ts", async (original) => {
  const actual = (await original()) as Record<string, unknown>;
  return {
    ...actual,
    getRedisIfConnected: () => {
      if (redisState.mode === "down") return undefined;
      return {
        incr: async (key: string) => {
          if (redisState.mode === "throws") throw new Error("connection lost");
          const next = (redisState.counts.get(key) ?? 0) + 1;
          redisState.counts.set(key, next);
          return next;
        },
        expire: async () => 1,
      };
    },
  };
});

const { apiKeys, contacts, createDatabase, linkedAccounts } = await import(
  "@hogsend/db"
);
const { eq, like } = await import("drizzle-orm");
const {
  createApp,
  createHogsendClient,
  generateUserToken,
  verifyConnectorState,
} = await import("@hogsend/engine");

/**
 * PRD 09 T7 — `POST /v1/accounts/link-url`, the DX unlock and the tightest
 * identity boundary in the feature (DECISIONS §6.5).
 *
 * Two properties are load-bearing and both are asserted structurally:
 *
 *  1. The minted URL's ORIGIN equals `new URL(API_PUBLIC_URL).origin` and its
 *     path is `/v1/accounts/<provider>/start`. PRD 13 derives its
 *     `postMessage` `expectedOrigin` from this value, so a provider-origin URL
 *     makes every embedded link time out with `AccountLinkTimeoutError` while
 *     the link committed server-side — and PRD 13's fake-`Window` tests cannot
 *     detect it. Asserting "a string came back" would not catch it either.
 *  2. The contact sealed into the state comes from the TOKEN. A `contactId`,
 *     `email` or differing `userId` in the body is a 403 with NO mint.
 */
const RUN = `allurl-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

const SECRET = "test-secret-for-vitest-minimum-32-characters-long";
const ORIGIN = "https://play.example.com";
const PK_KEY = `pk_test_${RUN}`;
const API_PUBLIC_URL = "http://localhost:3002";

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
let playerContactId = "";
let victimContactId = "";
const PLAYER = `${RUN}-player`;
const VICTIM = `${RUN}-victim`;

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

  const [player] = await db
    .insert(contacts)
    .values({ externalId: PLAYER, email: `${PLAYER}@example.com` })
    .returning({ id: contacts.id });
  playerContactId = player?.id ?? "";
  const [victim] = await db
    .insert(contacts)
    .values({ externalId: VICTIM, email: `${VICTIM}@example.com` })
    .returning({ id: contacts.id });
  victimContactId = victim?.id ?? "";
});

afterAll(async () => {
  await db
    .delete(linkedAccounts)
    .where(like(linkedAccounts.providerUserId, `${RUN}%`));
  await db.delete(contacts).where(like(contacts.externalId, `${RUN}%`));
  if (pkKeyId) await db.delete(apiKeys).where(eq(apiKeys.id, pkKeyId));
  await client.end();
});

beforeEach(() => {
  redisState.counts.clear();
  redisState.mode = "ok";
});

const token = (userId: string, expiresInSeconds?: number) =>
  generateUserToken({
    secret: SECRET,
    userId,
    ...(expiresInSeconds !== undefined ? { expiresInSeconds } : {}),
  });

function linkUrl(body: Record<string, unknown>) {
  return app.request("/v1/accounts/link-url", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${PK_KEY}`,
      Origin: ORIGIN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("POST /v1/accounts/link-url mints for the token's user only", () => {
  it("mints for the token's userId and seals THAT contact", async () => {
    const res = await linkUrl({ provider: "steam", userToken: token(PLAYER) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; expiresAt: string };

    const state = new URL(body.url).searchParams.get("t") as string;
    const check = verifyConnectorState(state, SECRET);
    expect(check.valid).toBe(true);
    expect(check.intent?.purpose).toBe("account_link");
    expect(check.intent?.providerId).toBe("steam");
    // THE contact — resolved from the token's userId, never from the request.
    expect(check.intent?.contactId).toBe(playerContactId);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("the minted url origin equals API_PUBLIC_URL's origin and its path is /v1/accounts/<provider>/start", async () => {
    const res = await linkUrl({ provider: "steam", userToken: token(PLAYER) });
    const { url } = (await res.json()) as { url: string };
    const parsed = new URL(url);

    // DECISIONS §15.2, and the exact assertion PRD 13 depends on.
    expect(parsed.origin).toBe(new URL(API_PUBLIC_URL).origin);
    expect(parsed.pathname).toBe("/v1/accounts/steam/start");
    // And NEVER the provider's authorize URL.
    expect(parsed.origin).not.toContain("provider.test");
  });

  it("403s with no userToken and mints nothing", async () => {
    const res = await linkUrl({ provider: "steam" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Invalid userToken" });
  });

  it("403s on an expired userToken", async () => {
    const res = await linkUrl({
      provider: "steam",
      userToken: token(PLAYER, -60),
    });
    expect(res.status).toBe(403);
  });

  it("403s on a forged signature", async () => {
    const forged = generateUserToken({
      secret: "an-entirely-different-secret-at-least-32-chars",
      userId: PLAYER,
    });
    const res = await linkUrl({ provider: "steam", userToken: forged });
    expect(res.status).toBe(403);
  });

  it("403s when the body claims a different userId than the token", async () => {
    const res = await linkUrl({
      provider: "steam",
      userToken: token(PLAYER),
      userId: VICTIM,
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "userToken does not authorize this identity",
    });
  });

  it("403s when the body carries a contactId", async () => {
    const res = await linkUrl({
      provider: "steam",
      userToken: token(PLAYER),
      contactId: victimContactId,
    });
    expect(res.status).toBe(403);
  });

  it("403s when the body carries an email", async () => {
    const res = await linkUrl({
      provider: "steam",
      userToken: token(PLAYER),
      email: `${VICTIM}@example.com`,
    });
    expect(res.status).toBe(403);
  });

  it("a body carrying the token's OWN userId is fine and still seals the token's contact", async () => {
    const res = await linkUrl({
      provider: "steam",
      userToken: token(PLAYER),
      userId: PLAYER,
    });
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    const state = new URL(url).searchParams.get("t") as string;
    expect(verifyConnectorState(state, SECRET).intent?.contactId).toBe(
      playerContactId,
    );
  });

  it("404s an unregistered provider", async () => {
    const res = await linkUrl({
      provider: "nintendo",
      userToken: token(PLAYER),
    });
    expect(res.status).toBe(404);
  });

  it("400s an off-allowlist returnTo, never a silent fallback", async () => {
    const res = await linkUrl({
      provider: "steam",
      userToken: token(PLAYER),
      returnTo: "https://evil.example.com/steal",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "return_to_not_allowed" });
  });

  it("accepts an allowlisted returnTo and seals it", async () => {
    const res = await linkUrl({
      provider: "steam",
      userToken: token(PLAYER),
      returnTo: `${ORIGIN}/settings`,
    });
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    const state = new URL(url).searchParams.get("t") as string;
    expect(verifyConnectorState(state, SECRET).intent?.returnTo).toBe(
      `${ORIGIN}/settings`,
    );
  });

  it("429s and returns no URL when the throttle rejects", async () => {
    // The per-contact budget is 20 per window; the 21st is refused.
    for (let i = 0; i < 20; i++) {
      const ok = await linkUrl({ provider: "steam", userToken: token(PLAYER) });
      expect(ok.status).toBe(200);
    }
    const res = await linkUrl({ provider: "steam", userToken: token(PLAYER) });
    expect(res.status).toBe(429);
    expect(await res.text()).not.toContain("/start");
  });

  it("429s and returns no URL when Redis is unavailable (fail closed)", async () => {
    redisState.mode = "down";
    const res = await linkUrl({ provider: "steam", userToken: token(PLAYER) });
    expect(res.status).toBe(429);
    expect(await res.text()).not.toContain("/start");
  });
});
