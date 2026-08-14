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

/** See accounts-link-url.test.ts — the same deterministic throttle seam. */
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
const { createApp, createHogsendClient, verifyConnectorState } = await import(
  "@hogsend/engine"
);

/**
 * PRD 09 T6 — `POST /v1/accounts/mint-link`, the OPERATOR mint.
 *
 * A secret key is server-trusted, so this one may seal any contact (that is
 * the entire difference from `/link-url`). It still returns an ENGINE-origin
 * `/start?t=` URL and it still FAILS CLOSED on the throttle: a mint that
 * succeeded while Redis was down hands out a state the hosted flow will refuse
 * anyway.
 */
const RUN = `almint-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

const SECRET = "test-secret-for-vitest-minimum-32-characters-long";
const SECRET_KEY = `hsk_test_${RUN}`;
const API_PUBLIC_URL = "http://localhost:3002";

const { db, client } = createDatabase({
  url: process.env.DATABASE_URL as string,
});

const steam = fakeAccountLink({ id: "steam", name: "Steam" });
const container = createHogsendClient({
  accountLinks: {
    providers: [steam],
    allowedOrigins: ["https://play.example.com"],
  },
});
const app = createApp(container);

const hashKey = (raw: string) => createHash("sha256").update(raw).digest("hex");

let secretKeyId = "";
let contactId = "";
const EXTERNAL = `${RUN}-player`;
const EMAIL = `${RUN}-player@example.com`;

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
    .insert(contacts)
    .values({ externalId: EXTERNAL, email: EMAIL })
    .returning({ id: contacts.id });
  contactId = row?.id ?? "";
});

afterAll(async () => {
  await db
    .delete(linkedAccounts)
    .where(like(linkedAccounts.providerUserId, `${RUN}%`));
  await db.delete(contacts).where(like(contacts.externalId, `${RUN}%`));
  if (secretKeyId) await db.delete(apiKeys).where(eq(apiKeys.id, secretKeyId));
  await client.end();
});

beforeEach(() => {
  redisState.counts.clear();
  redisState.mode = "ok";
});

function mintLink(body: Record<string, unknown>) {
  return app.request("/v1/accounts/mint-link", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("POST /v1/accounts/mint-link", () => {
  it("mints for an arbitrary contact on a secret key", async () => {
    const res = await mintLink({ provider: "steam", contactId });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; expiresAt: string };

    const parsed = new URL(body.url);
    expect(parsed.origin).toBe(new URL(API_PUBLIC_URL).origin);
    expect(parsed.pathname).toBe("/v1/accounts/steam/start");
    const state = parsed.searchParams.get("t") as string;
    expect(verifyConnectorState(state, SECRET).intent?.contactId).toBe(
      contactId,
    );
  });

  it("resolves the contact by email too", async () => {
    const res = await mintLink({ provider: "steam", email: EMAIL });
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    const state = new URL(url).searchParams.get("t") as string;
    expect(verifyConnectorState(state, SECRET).intent?.contactId).toBe(
      contactId,
    );
  });

  it("400s when no contact key is supplied", async () => {
    const res = await mintLink({ provider: "steam" });
    expect(res.status).toBe(400);
  });

  it("404s an unknown contact and mints nothing", async () => {
    const res = await mintLink({
      provider: "steam",
      email: `${RUN}-nobody@example.com`,
    });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("/start");
  });

  it("404s an unregistered provider", async () => {
    const res = await mintLink({ provider: "nintendo", contactId });
    expect(res.status).toBe(404);
  });

  it("429s and returns no URL when the throttle rejects", async () => {
    for (let i = 0; i < 20; i++) {
      expect((await mintLink({ provider: "steam", contactId })).status).toBe(
        200,
      );
    }
    const res = await mintLink({ provider: "steam", contactId });
    expect(res.status).toBe(429);
    expect(await res.text()).not.toContain("/start");
  });

  it("429s and returns no URL when Redis is unavailable (fail closed)", async () => {
    redisState.mode = "down";
    const res = await mintLink({ provider: "steam", contactId });
    expect(res.status).toBe(429);
    expect(await res.text()).not.toContain("/start");
  });

  it("429s when Redis faults mid-request (fail closed)", async () => {
    redisState.mode = "throws";
    const res = await mintLink({ provider: "steam", contactId });
    expect(res.status).toBe(429);
    expect(await res.text()).not.toContain("/start");
  });
});
