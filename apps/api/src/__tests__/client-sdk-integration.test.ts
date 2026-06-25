import { createHash, createHmac } from "node:crypto";
import { createHogsend, HogsendAPIError } from "@hogsend/js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// Hatchet is module-mocked: a successful POST /v1/events still stores the event
// + upserts the contact synchronously (what we assert), but never reaches a live
// gRPC engine. Journey EXECUTION is a worker concern proved live in dogfood; here
// we prove the WIRING — the SDK's interaction lands as a first-party, correctly
// attributed, `source:"inapp"` event that a journey trigger would route on.
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

const { apiKeys, contacts, emailPreferences, userEvents } = await import(
  "@hogsend/db"
);
const { and, eq } = await import("drizzle-orm");
const { createApp, createHogsendClient, defineList } = await import(
  "@hogsend/engine"
);

// A default-opt-in list so an unsubscribe is a real state flip in the assertion.
const MARKETING_LIST = defineList({
  id: "sdk-marketing",
  name: "SDK Marketing",
  defaultOptIn: true,
});

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
} as unknown as ReturnType<typeof createHogsendClient>["hatchet"];

const container = createHogsendClient({
  lists: [MARKETING_LIST],
  overrides: { hatchet: mockHatchet },
});
const app = createApp(container);
const { db } = container;

function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

// Same construction `verifyUserToken` expects, keyed by the vitest-injected
// BETTER_AUTH_SECRET. This is the v3 mint helper exercised early: a server-signed
// token lets the browser-direct pk_ key act as the bound userId.
const AUTH_SECRET = "test-secret-for-vitest-minimum-32-characters-long";
function mintUserToken(userId: string): string {
  const payload = { userId, exp: Math.floor(Date.now() / 1000) + 3600 };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", AUTH_SECRET)
    .update(body)
    .digest("base64url");
  return `${body}.${sig}`;
}

const ORIGIN = "https://sdk.example.com";
const PK_OK = "pk_sdk_integration_allowed_origin_key";
// Arbitrary engine origin — app.request() routes by pathname; the browser-set
// Origin HEADER (not the URL) is what the publishable gate checks.
const API_BASE = "https://sdk-engine.test";

const TOKEN_USER = "sdk-int-token-user";
const TOKEN_EMAIL = "sdk-int-token-user@example.com";

/**
 * A `fetch` that faithfully simulates a browser: routes the SDK's request into
 * the in-process Hono app and injects the `Origin` header the browser would add
 * (and which JS cannot set itself). This is the seam that makes the real SDK
 * testable against the real engine with zero network.
 */
function browserFetch(origin: string): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = new Headers(init?.headers);
    headers.set("Origin", origin);
    return app.request(url, { ...init, headers });
  }) as typeof fetch;
}

let pkId = "";

beforeAll(async () => {
  const [k] = await db
    .insert(apiKeys)
    .values({
      name: "sdk integration publishable",
      keyPrefix: PK_OK.slice(0, 8),
      keyHash: hashKey(PK_OK),
      scopes: ["ingest-public"],
      allowedOrigins: [ORIGIN],
    })
    .returning({ id: apiKeys.id });
  pkId = k?.id ?? "";

  // Identified-user fixture: externalId + email so the list write resolves an
  // email from the userId alone (the SDK sends userId+userToken, never email).
  await db
    .insert(contacts)
    .values({ externalId: TOKEN_USER, email: TOKEN_EMAIL });
});

afterAll(async () => {
  await db.delete(userEvents).where(eq(userEvents.userId, TOKEN_USER));
  await db
    .delete(emailPreferences)
    .where(eq(emailPreferences.userId, TOKEN_USER));
  await db.delete(contacts).where(eq(contacts.externalId, TOKEN_USER));
  if (pkId) await db.delete(apiKeys).where(eq(apiKeys.id, pkId));
});

describe("@hogsend/js ↔ engine closed loop (browser-direct pk_)", () => {
  it("anon capture → first-party user_events row, source 'inapp', no identity forged", async () => {
    const client = createHogsend({
      apiUrl: API_BASE,
      publishableKey: PK_OK,
      fetch: browserFetch(ORIGIN),
    });
    const anonId = client.getDistinctId();

    await client.capture("inapp.cta_clicked", { cta: "hero" });
    await client.flush();
    client.teardown();

    const rows = await db
      .select()
      .from(userEvents)
      .where(
        and(
          eq(userEvents.event, "inapp.cta_clicked"),
          eq(userEvents.userId, anonId),
        ),
      );
    expect(rows.length).toBe(1);
    // Provenance derived from the pk_ key class, not the (stripped) body field.
    expect(rows[0]?.source).toBe("inapp");
    expect(rows[0]?.properties).toMatchObject({ cta: "hero" });

    await db.delete(userEvents).where(eq(userEvents.userId, anonId));
    await db.delete(contacts).where(eq(contacts.anonymousId, anonId));
  });

  it("fail-closed: a non-allowed Origin is rejected (the SDK surfaces a 403)", async () => {
    const client = createHogsend({
      apiUrl: API_BASE,
      publishableKey: PK_OK,
      fetch: browserFetch("https://evil.example.com"),
    });
    // get() goes through transport.get, which throws on a non-2xx (unlike
    // capture(), whose queue drops terminal 4xx silently).
    const err = await client
      .preferences()
      .get()
      .catch((e: unknown) => e);
    client.teardown();
    expect(err).toBeInstanceOf(HogsendAPIError);
    expect((err as HogsendAPIError).status).toBe(403);
  });

  it("identified loop: userToken → setPreference flips email_preferences AND emits inapp.preference_changed", async () => {
    const client = createHogsend({
      apiUrl: API_BASE,
      publishableKey: PK_OK,
      userId: TOKEN_USER,
      userToken: mintUserToken(TOKEN_USER),
      fetch: browserFetch(ORIGIN),
    });

    await client.preferences().setPreference("sdk-marketing", false);
    await client.flush();
    client.teardown();

    // (a) the preference actually persisted to email_preferences
    const prefs = await db
      .select()
      .from(emailPreferences)
      .where(eq(emailPreferences.userId, TOKEN_USER));
    expect(prefs.length).toBe(1);
    expect(prefs[0]?.categories?.["sdk-marketing"]).toBe(false);

    // (b) the closed-loop event landed, attributed to the user, source inapp
    const evs = await db
      .select()
      .from(userEvents)
      .where(
        and(
          eq(userEvents.event, "inapp.preference_changed"),
          eq(userEvents.userId, TOKEN_USER),
        ),
      );
    expect(evs.length).toBeGreaterThanOrEqual(1);
    expect(evs[0]?.source).toBe("inapp");
    expect(evs[0]?.properties).toMatchObject({
      categoryId: "sdk-marketing",
      subscribed: false,
    });
  });

  it("anon preferences read returns the engine's { categories, unsubscribedAll } shape", async () => {
    const client = createHogsend({
      apiUrl: API_BASE,
      publishableKey: PK_OK,
      fetch: browserFetch(ORIGIN),
    });
    const prefs = await client.preferences().get();
    client.teardown();
    expect(prefs).toEqual({ categories: {}, unsubscribedAll: false });
  });
});
