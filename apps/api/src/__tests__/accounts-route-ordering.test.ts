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

const { apiKeys, contacts, createDatabase, linkedAccounts } = await import(
  "@hogsend/db"
);
const { eq, like } = await import("drizzle-orm");
const { createApp, createHogsendClient, generateUserToken } = await import(
  "@hogsend/engine"
);

/**
 * PRD 09 T9 — THE GUARD-SHADOWING HAZARD (DECISIONS §15.1).
 *
 * Hono runs EVERY matching `use`, and `app.route("/v1", v1)` flattens the
 * middleware into one router. So a blanket `v1.use("/accounts/*", ...)` also
 * matches the bare `/accounts` path and every literal sibling, and a `use` on
 * the two-segment PARAM pattern also matches `/accounts/steam/start`,
 * `/accounts/steam/callback` and `/accounts/me/revoke`.
 *
 * EVERY browser/player/hosted case below asserts NEITHER 401 NOR 403, never
 * merely "not 401": under the stacked guard a `pk_` key fails the SCOPE check
 * and the route answers 403, so a "not 401" assertion would ship the broken
 * routing green. That weakness is the entire reason this file exists.
 */
const RUN = `alorder-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

const SECRET = "test-secret-for-vitest-minimum-32-characters-long";
const ORIGIN = "https://play.example.com";
const PK_KEY = `pk_test_${RUN}`;
const SECRET_KEY = `hsk_test_${RUN}`;

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
let secretKeyId = "";
const PLAYER = `${RUN}-player`;
const userToken = generateUserToken({ secret: SECRET, userId: PLAYER });

/** Never a 401 and never a 403 — the routing assertion, stated once. */
function expectReachedHandler(status: number) {
  expect([401, 403]).not.toContain(status);
}

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

  await db.insert(contacts).values({ externalId: PLAYER });
});

afterAll(async () => {
  await db
    .delete(linkedAccounts)
    .where(like(linkedAccounts.providerUserId, `${RUN}%`));
  await db.delete(contacts).where(like(contacts.externalId, `${RUN}%`));
  if (pkKeyId) await db.delete(apiKeys).where(eq(apiKeys.id, pkKeyId));
  if (secretKeyId) await db.delete(apiKeys).where(eq(apiKeys.id, secretKeyId));
  await client.end();
});

const pkHeaders = {
  Authorization: `Bearer ${PK_KEY}`,
  Origin: ORIGIN,
  "Content-Type": "application/json",
};

describe("the browser-reachable literals are not shadowed by a secret guard", () => {
  it("GET /v1/accounts/me with a pk_ key and a valid userToken is neither 401 nor 403", async () => {
    const res = await app.request(
      `/v1/accounts/me?userToken=${encodeURIComponent(userToken)}`,
      { headers: pkHeaders },
    );
    expectReachedHandler(res.status);
    expect(res.status).toBe(200);
  });

  it("POST /v1/accounts/link-url with a pk_ key is neither 401 nor 403", async () => {
    const res = await app.request("/v1/accounts/link-url", {
      method: "POST",
      headers: pkHeaders,
      body: JSON.stringify({ provider: "steam", userToken }),
    });
    expectReachedHandler(res.status);
  });

  it("POST /v1/accounts/me/revoke with a pk_ key and a valid userToken is neither 401 nor 403", async () => {
    // The PRIMARY player unlink (DECISIONS §14). Under the stacked guard this
    // was a 403 forever: a pk_ key holds only `["ingest-public"]`.
    const res = await app.request("/v1/accounts/me/revoke", {
      method: "POST",
      headers: pkHeaders,
      body: JSON.stringify({ provider: "steam", userToken }),
    });
    expectReachedHandler(res.status);
    expect(res.status).toBe(200);
  });

  it("POST /v1/accounts/me/revoke reaches the revoke handler, not the reverse lookup", async () => {
    // `/me/revoke` has exactly the shape `/{provider}/{providerUserId}`
    // matches, so it is registered first. MEASURED, against PRD 09's claim
    // that this ordering is load-bearing TODAY: it is not, because Hono
    // matches on METHOD too and the param routes are GET + DELETE only —
    // moving `/me/revoke` after them keeps this file green. What IS live today
    // is the ordering for `/{provider}/start` and `/{provider}/callback` (both
    // GET, both two-segment), proven by the two hosted-flow cases below, and
    // the MIDDLEWARE collision, proven by the stacked-guard mutation. Keep the
    // literal first regardless: the day a POST lands on the param pattern the
    // collision becomes live with no other warning.
    const res = await app.request("/v1/accounts/me/revoke", {
      method: "POST",
      headers: pkHeaders,
      body: JSON.stringify({ provider: "steam", userToken }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: 0 });
  });
});

describe("the hosted flow stays unauthenticated (PRD 07)", () => {
  it("GET /v1/accounts/steam/start with no Authorization header is neither 401 nor 403", async () => {
    const res = await app.request("/v1/accounts/steam/start");
    expectReachedHandler(res.status);
    // 302 (redis up) or 503 (redis down, fail-closed) — both are the HANDLER
    // answering. Anything from the guard layer would be 401/403.
    expect([302, 503]).toContain(res.status);
  });

  it("GET /v1/accounts/steam/callback with no Authorization header is neither 401 nor 403", async () => {
    // Under the stacked guard the entire hosted OAuth flow was dead.
    const res = await app.request("/v1/accounts/steam/callback?state=nope");
    expectReachedHandler(res.status);
    expect([400, 503]).toContain(res.status);
  });

  // The exemptions above are gated on METHOD, not just on the path segment.
  // A Hono `use` matches every method, but the routes the exemptions exist for
  // are GET-only (start/callback) and POST-only (me/revoke). Gating on the
  // segment alone let a DELETE on the same shape skip the guard entirely and
  // fall through to the param route's DELETE — the secret-key operator unlink.
  it("DELETE /v1/accounts/steam/start with no key is 401, not the operator unlink", async () => {
    const res = await app.request("/v1/accounts/steam/start", {
      method: "DELETE",
    });
    expect(res.status).toBe(401);
  });

  it("DELETE /v1/accounts/steam/callback with no key is 401", async () => {
    const res = await app.request("/v1/accounts/steam/callback", {
      method: "DELETE",
    });
    expect(res.status).toBe(401);
  });

  it("DELETE /v1/accounts/me/revoke with a pk_ key is 403, not the operator unlink", async () => {
    // The publishable tier is granted to the POST literal only. On DELETE this
    // shape is the operator unlink, which a pk_ key may never reach.
    const res = await app.request("/v1/accounts/me/revoke", {
      method: "DELETE",
      headers: pkHeaders,
    });
    expect(res.status).toBe(403);
  });

  it("GET /v1/accounts/manage with no Authorization header is neither 401 nor 403", async () => {
    // PRD 11's unauthenticated, token-bearing player page. It is not built
    // yet, so it 404s — but it must NEVER be 401/403, or shipping PRD 11 will
    // land on a guard that already killed it.
    const res = await app.request("/v1/accounts/manage?token=whatever");
    expectReachedHandler(res.status);
  });
});

describe("the operator surface stays secret-only", () => {
  it("GET /v1/accounts with a pk_ key is 403", async () => {
    const res = await app.request("/v1/accounts?provider=steam", {
      headers: pkHeaders,
    });
    expect(res.status).toBe(403);
  });

  it("GET /v1/accounts with no key is 401", async () => {
    const res = await app.request("/v1/accounts?provider=steam");
    expect(res.status).toBe(401);
  });

  it("GET /v1/accounts/steam/765611980000 with no key is 401", async () => {
    const res = await app.request(`/v1/accounts/steam/${RUN}-nobody`);
    expect(res.status).toBe(401);
  });

  it("DELETE /v1/accounts/steam/... with a pk_ key is 403", async () => {
    const res = await app.request(`/v1/accounts/steam/${RUN}-nobody`, {
      method: "DELETE",
      headers: pkHeaders,
    });
    expect(res.status).toBe(403);
  });

  it("POST /v1/accounts/import with no key is 401", async () => {
    const res = await app.request("/v1/accounts/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows: [] }),
    });
    expect(res.status).toBe(401);
  });

  it("POST /v1/accounts/mint-link with a pk_ key is 403", async () => {
    const res = await app.request("/v1/accounts/mint-link", {
      method: "POST",
      headers: pkHeaders,
      body: JSON.stringify({ provider: "steam", contactId: PLAYER }),
    });
    expect(res.status).toBe(403);
  });

  it("a second segment that is NOT a reserved literal takes the operator branch", async () => {
    // `me` is in RESERVED_ACCOUNT_LINK_IDS so no provider can ever be named
    // it, and only `/me/revoke` branches to the browser tier — every other
    // `/me/<x>` is an ordinary (always-404) operator reverse lookup and still
    // demands a key.
    const res = await app.request("/v1/accounts/me/123");
    expect(res.status).toBe(401);
  });

  it("the secret key reaches the operator handler", async () => {
    const res = await app.request(`/v1/accounts/steam/${RUN}-nobody`, {
      headers: { Authorization: `Bearer ${SECRET_KEY}` },
    });
    expectReachedHandler(res.status);
    expect(res.status).toBe(404);
  });
});
