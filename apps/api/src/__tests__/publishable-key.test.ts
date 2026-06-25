import { createHash, createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// Hatchet is module-mocked so a successful `POST /v1/events` (which pushes
// through the ingest pipeline) never reaches a live gRPC engine. The auth gate
// runs before the handler, so the 401/403 paths never touch Hatchet anyway.
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

const { apiKeys, contacts, userEvents } = await import("@hogsend/db");
const { eq } = await import("drizzle-orm");
const { createApp, createHogsendClient, defineList } = await import(
  "@hogsend/engine"
);

// A code-defined list so the publishable subscribe/unsubscribe handlers resolve
// a real list id (an unknown id 404s before the identity gate runs). Opt-in so
// membership polarity is unambiguous in the assertions.
const TEST_LIST = defineList({
  id: "pk-test-list",
  name: "PK test list",
  defaultOptIn: false,
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
  lists: [TEST_LIST],
  overrides: { hatchet: mockHatchet },
});
const app = createApp(container);
const { db } = container;

function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

// Mint a userToken with the SAME construction `verifyUserToken` expects:
// `<base64url(JSON({userId,exp}))>.<HMAC-SHA256(body, secret) base64url>`, keyed
// by the vitest-injected BETTER_AUTH_SECRET. v1 ships no mint helper (publishable
// keys are anon-only by default), so the verify seam is exercised by minting the
// token directly here — proving the gate ACCEPTS a server-signed token and
// REJECTS forged / mismatched / expired ones.
const AUTH_SECRET = "test-secret-for-vitest-minimum-32-characters-long";
function mintUserToken(userId: string, expEpochSeconds?: number): string {
  const payload = {
    userId,
    exp: expEpochSeconds ?? Math.floor(Date.now() / 1000) + 3600,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", AUTH_SECRET)
    .update(body)
    .digest("base64url");
  return `${body}.${sig}`;
}

const ORIGIN = "https://app.example.com";

// A publishable (pk_) key WITH a matching Origin allowlist.
const PK_OK = "pk_test_publishable_allowed_origin_key";
// A publishable key WITH NO allowlist (null) — must fail closed.
const PK_NO_ALLOWLIST = "pk_test_publishable_no_allowlist_key";
// A secret ingest key — must still work everywhere it did before.
const INGEST_KEY = "hsk_test_publishable_ingest_key";

let pkOkId = "";
let pkNoAllowId = "";
let ingestId = "";

beforeAll(async () => {
  const [a] = await db
    .insert(apiKeys)
    .values({
      name: "pub allowed",
      keyPrefix: PK_OK.slice(0, 8),
      keyHash: hashKey(PK_OK),
      scopes: ["ingest-public"],
      allowedOrigins: [ORIGIN],
    })
    .returning({ id: apiKeys.id });
  pkOkId = a?.id ?? "";

  const [b] = await db
    .insert(apiKeys)
    .values({
      name: "pub no allowlist",
      keyPrefix: PK_NO_ALLOWLIST.slice(0, 8),
      keyHash: hashKey(PK_NO_ALLOWLIST),
      scopes: ["ingest-public"],
      allowedOrigins: null,
    })
    .returning({ id: apiKeys.id });
  pkNoAllowId = b?.id ?? "";

  const [c] = await db
    .insert(apiKeys)
    .values({
      name: "secret ingest",
      keyPrefix: INGEST_KEY.slice(0, 8),
      keyHash: hashKey(INGEST_KEY),
      scopes: ["ingest"],
    })
    .returning({ id: apiKeys.id });
  ingestId = c?.id ?? "";

  // GAP-1 fixture: an already-IDENTIFIED victim contact whose anonymousId is, by
  // design, browser-readable (posthog `get_distinct_id()`). A token-less pk_ key
  // must NOT be able to forge events as / poison this contact via the anon arm.
  await db.insert(contacts).values({
    externalId: VICTIM_EXTERNAL_ID,
    email: "pk-victim@example.com",
    anonymousId: VICTIM_ANON_ID,
    properties: { plan: "pro" },
  });
});

// The userId a valid userToken authorizes (test 5).
const TOKEN_USER = "pk-test-token-user";

// GAP-1 victim fixture keys.
const VICTIM_EXTERNAL_ID = "pk-victim-external-id";
const VICTIM_ANON_ID = "pk-victim-anon-id";

afterAll(async () => {
  await db.delete(userEvents).where(eq(userEvents.userId, "pk-test-anon-user"));
  await db.delete(userEvents).where(eq(userEvents.userId, TOKEN_USER));
  await db.delete(userEvents).where(eq(userEvents.userId, VICTIM_EXTERNAL_ID));
  await db.delete(contacts).where(eq(contacts.anonymousId, "pk-test-anon"));
  await db.delete(contacts).where(eq(contacts.externalId, TOKEN_USER));
  await db.delete(contacts).where(eq(contacts.externalId, VICTIM_EXTERNAL_ID));
  await db
    .delete(contacts)
    .where(eq(contacts.email, "pk-secret-sub@example.com"));
  if (pkOkId) await db.delete(apiKeys).where(eq(apiKeys.id, pkOkId));
  if (pkNoAllowId) await db.delete(apiKeys).where(eq(apiKeys.id, pkNoAllowId));
  if (ingestId) await db.delete(apiKeys).where(eq(apiKeys.id, ingestId));
});

describe("publishable-key browser ingest", () => {
  it("pk_ + matching Origin + anon body → 202 on /v1/events", async () => {
    const res = await app.request("/v1/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${PK_OK}`,
        Origin: ORIGIN,
      },
      body: JSON.stringify({
        name: "pk.test.anon",
        anonymousId: "pk-test-anon",
        eventProperties: { probe: true },
      }),
    });
    expect(res.status).toBe(202);
  });

  it("pk_ + matching Origin BUT a claimed email (no userToken) → 403", async () => {
    const res = await app.request("/v1/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${PK_OK}`,
        Origin: ORIGIN,
      },
      body: JSON.stringify({
        name: "pk.test.identity",
        email: "victim@example.com",
      }),
    });
    expect(res.status).toBe(403);
  });

  it("pk_ + a claimed userId (no userToken) → 403", async () => {
    const res = await app.request("/v1/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${PK_OK}`,
        Origin: ORIGIN,
      },
      body: JSON.stringify({ name: "pk.test.identity", userId: "someone" }),
    });
    expect(res.status).toBe(403);
  });

  it("pk_ + non-matching Origin → 403", async () => {
    const res = await app.request("/v1/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${PK_OK}`,
        Origin: "https://evil.example.com",
      },
      body: JSON.stringify({ name: "pk.test", anonymousId: "pk-test-anon" }),
    });
    expect(res.status).toBe(403);
  });

  it("pk_ + ABSENT Origin → 403", async () => {
    const res = await app.request("/v1/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${PK_OK}`,
      },
      body: JSON.stringify({ name: "pk.test", anonymousId: "pk-test-anon" }),
    });
    expect(res.status).toBe(403);
  });

  it("pk_ with EMPTY/NULL allowlist → 403 (fail-closed)", async () => {
    const res = await app.request("/v1/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${PK_NO_ALLOWLIST}`,
        Origin: ORIGIN,
      },
      body: JSON.stringify({ name: "pk.test", anonymousId: "pk-test-anon" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("publishable-key cannot escalate to secret-only routes", () => {
  for (const path of ["/v1/emails", "/v1/campaigns"]) {
    it(`pk_ → ${path} → 403 (scope ingest-public ≠ ingest)`, async () => {
      const res = await app.request(path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${PK_OK}`,
          Origin: ORIGIN,
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(403);
    });
  }

  it("pk_ → DELETE /v1/contacts → 403 (DELETE is secret-only)", async () => {
    const res = await app.request("/v1/contacts", {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${PK_OK}`,
        Origin: ORIGIN,
      },
      body: JSON.stringify({ userId: "someone" }),
    });
    expect(res.status).toBe(403);
  });

  it("pk_ → GET /v1/contacts/find → 403 (find is secret-only)", async () => {
    const res = await app.request("/v1/contacts/find?userId=x", {
      method: "GET",
      headers: { Authorization: `Bearer ${PK_OK}`, Origin: ORIGIN },
    });
    expect(res.status).toBe(403);
  });
});

describe("secret ingest key path is unchanged", () => {
  it("hsk_ ingest key → 202 on /v1/events (no Origin needed)", async () => {
    const res = await app.request("/v1/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${INGEST_KEY}`,
      },
      body: JSON.stringify({
        name: "pk.test.secret",
        userId: "pk-test-anon-user",
      }),
    });
    expect(res.status).toBe(202);
  });

  it("hsk_ ingest key → 200 on GET /v1/lists", async () => {
    const res = await app.request("/v1/lists", {
      method: "GET",
      headers: { Authorization: `Bearer ${INGEST_KEY}` },
    });
    expect(res.status).toBe(200);
  });

  it("no key → 401 on /v1/events", async () => {
    const res = await app.request("/v1/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", userId: "y" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("GET /v1/lists/preferences (publishable gate)", () => {
  it("pk_ + anonymousId → 200 { categories, unsubscribedAll }", async () => {
    const res = await app.request(
      "/v1/lists/preferences?anonymousId=pk-test-anon",
      {
        method: "GET",
        headers: { Authorization: `Bearer ${PK_OK}`, Origin: ORIGIN },
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      categories: Record<string, boolean>;
      unsubscribedAll: boolean;
    };
    expect(typeof body.unsubscribedAll).toBe("boolean");
    expect(typeof body.categories).toBe("object");
  });

  it("pk_ + a concrete email (no userToken) → 403", async () => {
    const res = await app.request(
      "/v1/lists/preferences?email=victim@example.com",
      {
        method: "GET",
        headers: { Authorization: `Bearer ${PK_OK}`, Origin: ORIGIN },
      },
    );
    expect(res.status).toBe(403);
  });

  it("preferences read with NO key → 401 (behind the same gate)", async () => {
    const res = await app.request(
      "/v1/lists/preferences?anonymousId=pk-test-anon",
      { method: "GET" },
    );
    expect(res.status).toBe(401);
  });
});

// ---- Test 5: the userToken VERIFY seam ----
// v1 ships no mint helper (publishable keys are anon-only by default), so we
// mint a token directly with the same HMAC construction `verifyUserToken`
// expects. This proves the gate ACCEPTS a server-signed token binding a userId,
// and REJECTS forged / mismatched / expired / email-bearing tokens.
describe("publishable-key userToken (identity assertion)", () => {
  it("pk_ + a VALID userToken for userId → 202 (may act on that userId)", async () => {
    const token = mintUserToken(TOKEN_USER);
    const res = await app.request("/v1/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${PK_OK}`,
        Origin: ORIGIN,
      },
      body: JSON.stringify({
        name: "pk.test.tokened",
        userId: TOKEN_USER,
        userToken: token,
      }),
    });
    expect(res.status).toBe(202);
  });

  it("pk_ + a token for a DIFFERENT userId than claimed → 403", async () => {
    const token = mintUserToken("someone-else");
    const res = await app.request("/v1/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${PK_OK}`,
        Origin: ORIGIN,
      },
      body: JSON.stringify({
        name: "pk.test.mismatch",
        userId: TOKEN_USER,
        userToken: token,
      }),
    });
    expect(res.status).toBe(403);
  });

  it("pk_ + a FORGED token (bad signature) → 403", async () => {
    const valid = mintUserToken(TOKEN_USER);
    const [body] = valid.split(".");
    const forged = `${body}.${"x".repeat(43)}`; // wrong, same-ish length sig
    const res = await app.request("/v1/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${PK_OK}`,
        Origin: ORIGIN,
      },
      body: JSON.stringify({
        name: "pk.test.forged",
        userId: TOKEN_USER,
        userToken: forged,
      }),
    });
    expect(res.status).toBe(403);
  });

  it("pk_ + an EXPIRED token → 403", async () => {
    const expired = mintUserToken(
      TOKEN_USER,
      Math.floor(Date.now() / 1000) - 1,
    );
    const res = await app.request("/v1/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${PK_OK}`,
        Origin: ORIGIN,
      },
      body: JSON.stringify({
        name: "pk.test.expired",
        userId: TOKEN_USER,
        userToken: expired,
      }),
    });
    expect(res.status).toBe(403);
  });

  it("pk_ + a valid token BUT also asserting an email → 403 (no email arm)", async () => {
    const token = mintUserToken(TOKEN_USER);
    const res = await app.request("/v1/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${PK_OK}`,
        Origin: ORIGIN,
      },
      body: JSON.stringify({
        name: "pk.test.email-with-token",
        userId: TOKEN_USER,
        email: "victim@example.com",
        userToken: token,
      }),
    });
    expect(res.status).toBe(403);
  });
});

// ---- Contacts upsert (bare PUT/POST /v1/contacts) under the publishable gate ----
//
// KNOWN IMPLEMENTATION BUG (for the Fix phase) — these two success-path tests
// currently FAIL with `403 {"error":"Forbidden: insufficient scope"}`:
//
// In `packages/engine/src/routes/index.ts`, the bare `/contacts` publishable
// guard (`v1.use("/contacts", methodBranch)`) accepts the pk_ key and sets
// `publishable = true`, but the secret-only catch-all
// `v1.use("/contacts/*", requireApiKey, requireScope("ingest"))` ALSO matches
// the bare `/contacts` path in this Hono version (verified: a `/contacts/*`
// `use` fires on a bare `/contacts` request) and rejects the pk_ key because
// `["ingest-public"]` is neither `ingest` nor `full-admin`. So the publishable
// contacts upsert is unreachable by ANY pk_ key — it always 403s.
//
// This is the EXACT collision the implementer already fixed for `/lists` (they
// dropped the `/lists/*` secret catch-all for this reason) but left in place for
// `/contacts/*`. The fix is symmetric: drop the `/contacts/*` catch-all and
// explicitly guard `/contacts/find` (the only current secret-only `/contacts`
// subtree route) with `requireApiKey + requireScope("ingest")`. The
// asserts below are INTENTIONALLY left at 200 (the spec'd behavior) — do not
// weaken them.
describe("publishable-key contacts upsert", () => {
  it("pk_ + anon body (no claimed identity) → 200", async () => {
    const res = await app.request("/v1/contacts", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${PK_OK}`,
        Origin: ORIGIN,
      },
      body: JSON.stringify({
        anonymousId: "pk-test-anon",
        properties: { probe: true },
      }),
    });
    expect(res.status).toBe(200);
  });

  it("pk_ + a claimed email (no userToken) → 403", async () => {
    const res = await app.request("/v1/contacts", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${PK_OK}`,
        Origin: ORIGIN,
      },
      body: JSON.stringify({ email: "victim@example.com" }),
    });
    expect(res.status).toBe(403);
  });

  it("pk_ + a VALID userToken → 200 (may upsert that userId)", async () => {
    const token = mintUserToken(TOKEN_USER);
    const res = await app.request("/v1/contacts", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${PK_OK}`,
        Origin: ORIGIN,
      },
      body: JSON.stringify({ userId: TOKEN_USER, userToken: token }),
    });
    expect(res.status).toBe(200);
  });

  it("secret ingest key → 200 on PUT /v1/contacts (regression)", async () => {
    const res = await app.request("/v1/contacts", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${INGEST_KEY}`,
      },
      body: JSON.stringify({ userId: "pk-test-anon-user" }),
    });
    expect(res.status).toBe(200);
  });

  it("pk_ + a non-matching Origin → 403 on contacts upsert (Origin gate is per-route-guard)", async () => {
    const res = await app.request("/v1/contacts", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${PK_OK}`,
        Origin: "https://evil.example.com",
      },
      body: JSON.stringify({ anonymousId: "pk-test-anon" }),
    });
    expect(res.status).toBe(403);
  });
});

// ---- List subscribe / unsubscribe under the publishable gate ----
describe("publishable-key list subscribe/unsubscribe", () => {
  it("pk_ + a claimed email (no userToken) → 403 on subscribe", async () => {
    const res = await app.request("/v1/lists/pk-test-list/subscribe", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${PK_OK}`,
        Origin: ORIGIN,
      },
      body: JSON.stringify({ email: "victim@example.com" }),
    });
    expect(res.status).toBe(403);
  });

  it("pk_ + a claimed userId (no userToken) → 403 on unsubscribe", async () => {
    const res = await app.request("/v1/lists/pk-test-list/unsubscribe", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${PK_OK}`,
        Origin: ORIGIN,
      },
      body: JSON.stringify({ userId: "someone" }),
    });
    expect(res.status).toBe(403);
  });

  it("secret ingest key → 200 on subscribe (regression)", async () => {
    // Subscribe writes `email_preferences`, which requires a resolvable email
    // (a bare userId with no email 400s) — mirror lists-dataplane.test.ts.
    const res = await app.request("/v1/lists/pk-test-list/subscribe", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${INGEST_KEY}`,
      },
      body: JSON.stringify({ email: "pk-secret-sub@example.com" }),
    });
    expect(res.status).toBe(200);
  });

  it("pk_ + NON-matching Origin → 403 on subscribe (Origin gate enforced)", async () => {
    const res = await app.request("/v1/lists/pk-test-list/subscribe", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${PK_OK}`,
        Origin: "https://evil.example.com",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
  });
});

// ---- GAP-1: anonymousId identity-forgery is closed on the publishable path ----
// A token-less pk_ key holds the victim's browser-readable anonymousId
// (`get_distinct_id()`). It must NOT be able to forge events as / poison the
// victim's already-IDENTIFIED contact through the anon resolution arm.
describe("publishable-key anonymousId forgery is blocked", () => {
  it("pk_ + a victim's anonymousId (resolves to an identified contact) → 403 on events", async () => {
    const res = await app.request("/v1/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${PK_OK}`,
        Origin: ORIGIN,
      },
      body: JSON.stringify({
        name: "pk.test.forge",
        anonymousId: VICTIM_ANON_ID,
        eventProperties: { forged: true },
      }),
    });
    expect(res.status).toBe(403);
  });

  it("pk_ + a victim's anonymousId → 403 on contacts upsert (no property clobber)", async () => {
    const res = await app.request("/v1/contacts", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${PK_OK}`,
        Origin: ORIGIN,
      },
      body: JSON.stringify({
        anonymousId: VICTIM_ANON_ID,
        properties: { plan: null },
      }),
    });
    expect(res.status).toBe(403);

    // The victim's properties must be untouched (the clamp threw before any
    // write).
    const [victim] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.externalId, VICTIM_EXTERNAL_ID))
      .limit(1);
    expect(victim?.properties).toEqual({ plan: "pro" });
  });

  it("secret ingest key + anonymousId is governed by requireIdentity, NOT the clamp (anon-only → 400)", async () => {
    // The clamp only fires on the publishable path (`restrictToAnonymous` is set
    // ONLY by the two pk_-reachable routes). On the SECRET path it is never set,
    // so the anon arm is governed by the UNCHANGED `requireIdentity` — an
    // anon-only secret ingest 400s (its pre-existing behavior), proving the
    // clamp did not alter the secret path.
    const res = await app.request("/v1/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${INGEST_KEY}`,
      },
      body: JSON.stringify({
        name: "pk.test.server-anon",
        anonymousId: VICTIM_ANON_ID,
      }),
    });
    expect(res.status).toBe(400);
  });
});

// ---- Scope escalation: a pk_ key cannot reach the admin surface ----
// `requireAdmin` must require `full-admin` on the Bearer path; an
// `ingest-public` (or any non-full-admin) key must be rejected — otherwise a
// browser-embedded pk_ key could read admin and mint a full-admin secret.
describe("publishable-key cannot reach /v1/admin/*", () => {
  it("pk_ → GET /v1/admin/api-keys → 403", async () => {
    const res = await app.request("/v1/admin/api-keys", {
      method: "GET",
      headers: { Authorization: `Bearer ${PK_OK}`, Origin: ORIGIN },
    });
    expect(res.status).toBe(403);
  });

  it("pk_ → POST /v1/admin/api-keys (mint full-admin) → 403", async () => {
    const res = await app.request("/v1/admin/api-keys", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${PK_OK}`,
        Origin: ORIGIN,
      },
      body: JSON.stringify({ name: "escalation", scopes: ["full-admin"] }),
    });
    expect(res.status).toBe(403);
  });

  it("secret ingest key (non-full-admin) → 403 on admin too (regression-safe)", async () => {
    const res = await app.request("/v1/admin/api-keys", {
      method: "GET",
      headers: { Authorization: `Bearer ${INGEST_KEY}` },
    });
    expect(res.status).toBe(403);
  });
});
