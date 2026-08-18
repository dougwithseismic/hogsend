import { createHash } from "node:crypto";
import type { HogsendClient } from "@hogsend/engine";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { apiKeys, contacts } = await import("@hogsend/db");
const { eq, inArray } = await import("drizzle-orm");
const { createApp, createHogsendClient, generateUserToken } = await import(
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

// TWO deploys of the same engine: the default (nothing configured, so nothing
// exposed) and one with an explicit allowlist. They share the DB.
const closedContainer = createHogsendClient({
  overrides: { hatchet: mockHatchet },
});
const closedApp = createApp(closedContainer);

const openContainer = createHogsendClient({
  overrides: { hatchet: mockHatchet },
  contacts: { publicProperties: ["plan", "seats"], exposeEmail: true },
});
const openApp = createApp(openContainer);

const noEmailContainer = createHogsendClient({
  overrides: { hatchet: mockHatchet },
  contacts: { publicProperties: ["plan"] },
});
const noEmailApp = createApp(noEmailContainer);

const { db } = closedContainer;

const SECRET = "test-secret-for-vitest-minimum-32-characters-long";
const RUN = `cme-${Date.now()}`;
const ORIGIN = "https://app.example.com";
const PK_KEY = `pk_${RUN}_publishable`;
const SECRET_KEY = `sk_${RUN}_ingest`;
const READ_ONLY_KEY = `sk_${RUN}_readonly`;
const IDENTIFIED_USER = `${RUN}-identified`;
const ANON_ID = `${RUN}-anon`;
const STITCHED_USER = `${RUN}-stitched`;
const STITCHED_ANON = `${RUN}-stitched-anon`;
const EMAIL = `${RUN}@example.com`;

const PK_HEADERS = { Authorization: `Bearer ${PK_KEY}`, Origin: ORIGIN };
const SK_HEADERS = { Authorization: `Bearer ${SECRET_KEY}` };
const READ_ONLY_HEADERS = { Authorization: `Bearer ${READ_ONLY_KEY}` };

function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

interface MeBody {
  identified: boolean;
  traits: Record<string, unknown>;
  email?: string | null;
}

let pkId = "";
let secretId = "";
let readOnlyId = "";

beforeAll(async () => {
  const [pk] = await db
    .insert(apiKeys)
    .values({
      name: "contacts/me pub",
      keyPrefix: PK_KEY.slice(0, 8),
      keyHash: hashKey(PK_KEY),
      scopes: ["ingest-public"],
      allowedOrigins: [ORIGIN],
    })
    .returning({ id: apiKeys.id });
  pkId = pk?.id ?? "";

  const [sk] = await db
    .insert(apiKeys)
    .values({
      name: "contacts/me secret",
      keyPrefix: SECRET_KEY.slice(0, 8),
      keyHash: hashKey(SECRET_KEY),
      scopes: ["ingest"],
    })
    .returning({ id: apiKeys.id });
  secretId = sk?.id ?? "";

  const [ro] = await db
    .insert(apiKeys)
    .values({
      name: "contacts/me read-only",
      keyPrefix: READ_ONLY_KEY.slice(0, 8),
      keyHash: hashKey(READ_ONLY_KEY),
      scopes: ["read"],
    })
    .returning({ id: apiKeys.id });
  readOnlyId = ro?.id ?? "";

  // The identified contact whose traits the allowlist projects.
  await db.insert(contacts).values({
    externalId: IDENTIFIED_USER,
    email: EMAIL,
    properties: { plan: "pro", seats: 12, ssn: "secret-value" },
  });

  // The browser's OWN anonymous contact.
  await db.insert(contacts).values({
    anonymousId: ANON_ID,
    properties: { plan: "free", ssn: "anon-secret" },
  });

  // An IDENTIFIED contact whose `anonymous_id` COLUMN still holds a browser
  // anon id (a server-side stitch, or a pre-logout id). That value is not a
  // canonical key, so `collidesWithIdentified` lets it through and the
  // resolver pins this identified row.
  await db.insert(contacts).values({
    externalId: STITCHED_USER,
    email: `${RUN}-stitched@example.com`,
    anonymousId: STITCHED_ANON,
    properties: { plan: "enterprise" },
  });
});

afterAll(async () => {
  await db
    .delete(contacts)
    .where(inArray(contacts.externalId, [IDENTIFIED_USER, STITCHED_USER]));
  await db.delete(contacts).where(eq(contacts.anonymousId, ANON_ID));
  if (pkId) await db.delete(apiKeys).where(eq(apiKeys.id, pkId));
  if (secretId) await db.delete(apiKeys).where(eq(apiKeys.id, secretId));
  if (readOnlyId) await db.delete(apiKeys).where(eq(apiKeys.id, readOnlyId));
});

const token = (userId: string) => generateUserToken({ secret: SECRET, userId });

describe("GET /v1/contacts/me", () => {
  it("empty allowlist exposes nothing, even with a valid userToken", async () => {
    const res = await closedApp.request(
      `/v1/contacts/me?userToken=${encodeURIComponent(token(IDENTIFIED_USER))}`,
      { method: "GET", headers: PK_HEADERS },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as MeBody;
    expect(body.identified).toBe(true);
    expect(body.traits).toEqual({});
    expect(body.email).toBeUndefined();
  });

  it("returns the allowlisted subset and omits everything else", async () => {
    const res = await openApp.request(
      `/v1/contacts/me?userToken=${encodeURIComponent(token(IDENTIFIED_USER))}`,
      { method: "GET", headers: PK_HEADERS },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as MeBody;
    expect(body.identified).toBe(true);
    expect(body.traits).toEqual({ plan: "pro", seats: 12 });
    expect(body.traits.ssn).toBeUndefined();
  });

  it("includes email ONLY when exposeEmail is on", async () => {
    const withEmail = (await (
      await openApp.request(
        `/v1/contacts/me?userToken=${encodeURIComponent(token(IDENTIFIED_USER))}`,
        { method: "GET", headers: PK_HEADERS },
      )
    ).json()) as MeBody;
    expect(withEmail.email).toBe(EMAIL);

    const withoutEmail = (await (
      await noEmailApp.request(
        `/v1/contacts/me?userToken=${encodeURIComponent(token(IDENTIFIED_USER))}`,
        { method: "GET", headers: PK_HEADERS },
      )
    ).json()) as MeBody;
    expect(withoutEmail.traits).toEqual({ plan: "pro" });
    expect(withoutEmail.email).toBeUndefined();
  });

  it("a forged userToken → 403", async () => {
    const forged = generateUserToken({
      secret: "another-secret-that-is-at-least-32-characters",
      userId: IDENTIFIED_USER,
    });
    const res = await openApp.request(
      `/v1/contacts/me?userToken=${encodeURIComponent(forged)}`,
      { method: "GET", headers: PK_HEADERS },
    );
    expect(res.status).toBe(403);
  });

  it("a pk_ anon caller reads its OWN anon row's traits (not identified)", async () => {
    const res = await openApp.request(
      `/v1/contacts/me?anonymousId=${encodeURIComponent(ANON_ID)}`,
      { method: "GET", headers: PK_HEADERS },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as MeBody;
    expect(body.traits).toEqual({ plan: "free" });
    // Anonymous-only row: it reads its own traits but is NOT identified.
    expect(body.identified).toBe(false);
    expect(body.email).toBeNull();
  });

  it("a token-less pk_ anon id pinned to an IDENTIFIED row reads nothing", async () => {
    // pk_ is anon-only: identity is a server-minted userToken. The row is
    // reachable (the resolver pins it), but its traits are not.
    const res = await openApp.request(
      `/v1/contacts/me?anonymousId=${encodeURIComponent(STITCHED_ANON)}`,
      { method: "GET", headers: PK_HEADERS },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as MeBody;
    expect(body).toEqual({ identified: false, traits: {}, email: null });

    // The same row IS readable through a token for that user.
    const viaToken = await openApp.request(
      `/v1/contacts/me?userToken=${encodeURIComponent(token(STITCHED_USER))}`,
      { method: "GET", headers: PK_HEADERS },
    );
    expect(viaToken.status).toBe(200);
    const tokenBody = (await viaToken.json()) as MeBody;
    expect(tokenBody.identified).toBe(true);
    expect(tokenBody.traits).toEqual({ plan: "enterprise" });
  });

  it("a pk_ anonymousId colliding with an IDENTIFIED contact → 403", async () => {
    const res = await openApp.request(
      `/v1/contacts/me?anonymousId=${encodeURIComponent(IDENTIFIED_USER)}`,
      { method: "GET", headers: PK_HEADERS },
    );
    expect(res.status).toBe(403);
  });

  it("a pk_ raw userId/email is ignored → 400 when nothing else identifies", async () => {
    const byUserId = await openApp.request(
      `/v1/contacts/me?userId=${encodeURIComponent(IDENTIFIED_USER)}`,
      { method: "GET", headers: PK_HEADERS },
    );
    expect(byUserId.status).toBe(400);

    const byEmail = await openApp.request(
      `/v1/contacts/me?email=${encodeURIComponent(EMAIL)}`,
      { method: "GET", headers: PK_HEADERS },
    );
    expect(byEmail.status).toBe(400);
  });

  it("a secret key's userId is server-trusted", async () => {
    const res = await openApp.request(
      `/v1/contacts/me?userId=${encodeURIComponent(IDENTIFIED_USER)}`,
      { method: "GET", headers: SK_HEADERS },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as MeBody;
    expect(body.identified).toBe(true);
    expect(body.traits).toEqual({ plan: "pro", seats: 12 });
    expect(body.email).toBe(EMAIL);
  });

  it("no Authorization header → 401 (the guard is mounted)", async () => {
    const res = await openApp.request(
      `/v1/contacts/me?userToken=${encodeURIComponent(token(IDENTIFIED_USER))}`,
      { method: "GET" },
    );
    expect(res.status).toBe(401);
  });

  it("a secret key without the ingest scope → 403", async () => {
    const res = await openApp.request(
      `/v1/contacts/me?userId=${encodeURIComponent(IDENTIFIED_USER)}`,
      { method: "GET", headers: READ_ONLY_HEADERS },
    );
    expect(res.status).toBe(403);
  });

  it("no identity → 400", async () => {
    const res = await openApp.request("/v1/contacts/me", {
      method: "GET",
      headers: PK_HEADERS,
    });
    expect(res.status).toBe(400);
  });
});
