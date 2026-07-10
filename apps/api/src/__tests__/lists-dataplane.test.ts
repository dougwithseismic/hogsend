import { createHash, createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

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

const { apiKeys, contacts, emailPreferences } = await import("@hogsend/db");
const { eq } = await import("drizzle-orm");
const { createApp, createHogsendClient, defineConnectorAction, defineList } =
  await import("@hogsend/engine");

// `product-updates` is opt-in (defaultOptIn:false): subscribe must set the
// category to exactly `true`, unsubscribe to `false`.
const productUpdates = defineList({
  id: "product-updates",
  name: "Product updates",
  description: "Occasional product news.",
  defaultOptIn: false,
});

// A member-directed connector action synthesizes a `discord` channel list
// (kind:"channel") in the registry — the catalog + channel-write assertions
// below need a real channel id to exist.
const discordDm = defineConnectorAction({
  connectorId: "discord",
  name: "dmMember",
  audience: {
    kind: "member",
    ref: (args: { userId: string }) => args.userId,
  },
  run: async () => ({ ok: true }),
});

const container = createHogsendClient({
  lists: [productUpdates],
  connectorActions: [discordDm],
});
const app = createApp(container);
const { db } = container;

const AUTH_HEADER = {
  Authorization: `Bearer ${process.env.ADMIN_API_KEY}`,
  "Content-Type": "application/json",
};

const RUN = `ldp-${Date.now()}`;
const SUB_EMAIL = `${RUN}-sub@example.com`;
const NOEMAIL_USER = `${RUN}-noemail`;
// A contact with BOTH external_id + email — the master-toggle write resolves a
// real (external_id, email) pair from it.
const PREF_USER = `${RUN}-pref-user`;
const PREF_EMAIL = `${RUN}-pref@example.com`;
// The userId a valid pk_ userToken authorizes (also seeded WITH an email so the
// master toggle resolves to a writable row).
const TOKEN_USER = `${RUN}-token-user`;
const TOKEN_EMAIL = `${RUN}-token@example.com`;

// ---- Publishable-key (pk_) test infra — mirrors publishable-key.test.ts ----
const AUTH_SECRET = "test-secret-for-vitest-minimum-32-characters-long";
const ORIGIN = "https://app.example.com";
const PK_OK = "pk_test_ldp_publishable_allowed_origin";
let pkOkId = "";

function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

// Mint a userToken with the construction `verifyUserToken` expects:
// `<base64url(JSON({userId,exp}))>.<HMAC-SHA256(body, secret) base64url>`.
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

beforeAll(async () => {
  // A contact with an external_id but NO email — list writes require a
  // resolvable email (risk 10), so this drives the 400 path.
  await db
    .insert(contacts)
    .values({ externalId: NOEMAIL_USER, email: null })
    .onConflictDoNothing();

  // Identified contacts (external_id + email) so the master-toggle write
  // resolves a writable `(external_id, email)` pair.
  await db
    .insert(contacts)
    .values([
      { externalId: PREF_USER, email: PREF_EMAIL },
      { externalId: TOKEN_USER, email: TOKEN_EMAIL },
    ])
    .onConflictDoNothing();

  const [pk] = await db
    .insert(apiKeys)
    .values({
      name: "ldp pub allowed",
      keyPrefix: PK_OK.slice(0, 8),
      keyHash: hashKey(PK_OK),
      scopes: ["ingest-public"],
      allowedOrigins: [ORIGIN],
    })
    .returning({ id: apiKeys.id });
  pkOkId = pk?.id ?? "";
});

afterAll(async () => {
  await db
    .delete(emailPreferences)
    .where(eq(emailPreferences.email, SUB_EMAIL));
  await db
    .delete(emailPreferences)
    .where(eq(emailPreferences.email, PREF_EMAIL));
  await db
    .delete(emailPreferences)
    .where(eq(emailPreferences.email, TOKEN_EMAIL));
  await db.delete(contacts).where(eq(contacts.email, SUB_EMAIL));
  await db.delete(contacts).where(eq(contacts.externalId, NOEMAIL_USER));
  await db.delete(contacts).where(eq(contacts.externalId, PREF_USER));
  await db.delete(contacts).where(eq(contacts.externalId, TOKEN_USER));
  if (pkOkId) await db.delete(apiKeys).where(eq(apiKeys.id, pkOkId));
});

describe("GET /v1/lists", () => {
  it("returns the enabled, code-defined lists", async () => {
    const res = await app.request("/v1/lists", { headers: AUTH_HEADER });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.lists).toBeInstanceOf(Array);
    const pu = body.lists.find(
      (l: { id: string }) => l.id === "product-updates",
    );
    expect(pu).toBeDefined();
    expect(pu.name).toBe("Product updates");
    expect(pu.defaultOptIn).toBe(false);
  });

  it("carries `kind`: user lists are topics, synthesized channels are channels", async () => {
    const res = await app.request("/v1/lists", { headers: AUTH_HEADER });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      lists: { id: string; kind: string }[];
    };

    const pu = body.lists.find((l) => l.id === "product-updates");
    expect(pu?.kind).toBe("topic");

    // The member-directed discord action synthesizes a `discord` channel; the
    // in-app feed channel is always synthesized.
    const discord = body.lists.find((l) => l.id === "discord");
    expect(discord?.kind).toBe("channel");
    const inApp = body.lists.find((l) => l.id === "in_app");
    expect(inApp?.kind).toBe("channel");
  });
});

describe("POST /v1/lists/:channel/unsubscribe (channels use the list write path)", () => {
  it("flips categories.<channel-id> to false", async () => {
    const res = await app.request("/v1/lists/discord/unsubscribe", {
      method: "POST",
      headers: AUTH_HEADER,
      body: JSON.stringify({ email: SUB_EMAIL }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.list).toBe("discord");
    expect(body.subscribed).toBe(false);

    const [prefs] = await db
      .select()
      .from(emailPreferences)
      .where(eq(emailPreferences.email, SUB_EMAIL));
    const categories = prefs?.categories as Record<string, boolean>;
    expect(categories?.discord).toBe(false);
  });
});

describe("POST /v1/lists/preferences (global master opt-out)", () => {
  it("secret key + userId flips unsubscribedAll true then false", async () => {
    const on = await app.request("/v1/lists/preferences", {
      method: "POST",
      headers: AUTH_HEADER,
      body: JSON.stringify({ userId: PREF_USER, unsubscribedAll: true }),
    });
    expect(on.status).toBe(200);
    expect((await on.json()).unsubscribedAll).toBe(true);

    const [afterOn] = await db
      .select()
      .from(emailPreferences)
      .where(eq(emailPreferences.userId, PREF_USER));
    expect(afterOn?.unsubscribedAll).toBe(true);

    const off = await app.request("/v1/lists/preferences", {
      method: "POST",
      headers: AUTH_HEADER,
      body: JSON.stringify({ userId: PREF_USER, unsubscribedAll: false }),
    });
    expect(off.status).toBe(200);
    expect((await off.json()).unsubscribedAll).toBe(false);

    const [afterOff] = await db
      .select()
      .from(emailPreferences)
      .where(eq(emailPreferences.userId, PREF_USER));
    expect(afterOff?.unsubscribedAll).toBe(false);
  });

  it("returns 401 with no auth (the method-agnostic path guard covers POST)", async () => {
    const res = await app.request("/v1/lists/preferences", {
      method: "POST",
      body: JSON.stringify({ userId: PREF_USER, unsubscribedAll: true }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 400 when neither email nor userId is supplied", async () => {
    const res = await app.request("/v1/lists/preferences", {
      method: "POST",
      headers: AUTH_HEADER,
      body: JSON.stringify({ unsubscribedAll: true }),
    });
    expect(res.status).toBe(400);
  });

  it("pk_ + a concrete userId WITHOUT a userToken → 403", async () => {
    const res = await app.request("/v1/lists/preferences", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${PK_OK}`,
        Origin: ORIGIN,
      },
      body: JSON.stringify({ userId: "someone", unsubscribedAll: true }),
    });
    expect(res.status).toBe(403);
  });

  it("pk_ + a VALID userToken for the claimed userId → 200", async () => {
    const token = mintUserToken(TOKEN_USER);
    const res = await app.request("/v1/lists/preferences", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${PK_OK}`,
        Origin: ORIGIN,
      },
      body: JSON.stringify({
        userId: TOKEN_USER,
        userToken: token,
        unsubscribedAll: true,
      }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).unsubscribedAll).toBe(true);

    const [row] = await db
      .select()
      .from(emailPreferences)
      .where(eq(emailPreferences.userId, TOKEN_USER));
    expect(row?.unsubscribedAll).toBe(true);
  });
});

describe("GET /v1/admin/lists", () => {
  it("returns the full registry with kinds (topics + channels)", async () => {
    const res = await app.request("/v1/admin/lists", {
      headers: { Authorization: `Bearer ${process.env.ADMIN_API_KEY}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      lists: { id: string; kind: string; enabled: boolean }[];
    };

    const pu = body.lists.find((l) => l.id === "product-updates");
    expect(pu?.kind).toBe("topic");
    const discord = body.lists.find((l) => l.id === "discord");
    expect(discord?.kind).toBe("channel");
    const inApp = body.lists.find((l) => l.id === "in_app");
    expect(inApp?.kind).toBe("channel");
  });
});

describe("POST /v1/lists/:id/(un)subscribe", () => {
  it("subscribe flips the category to true", async () => {
    const res = await app.request("/v1/lists/product-updates/subscribe", {
      method: "POST",
      headers: AUTH_HEADER,
      body: JSON.stringify({ email: SUB_EMAIL }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.list).toBe("product-updates");
    expect(body.subscribed).toBe(true);

    const [prefs] = await db
      .select()
      .from(emailPreferences)
      .where(eq(emailPreferences.email, SUB_EMAIL));
    const categories = prefs?.categories as Record<string, boolean>;
    expect(categories?.["product-updates"]).toBe(true);
  });

  it("unsubscribe flips the SAME category back to false", async () => {
    const res = await app.request("/v1/lists/product-updates/unsubscribe", {
      method: "POST",
      headers: AUTH_HEADER,
      body: JSON.stringify({ email: SUB_EMAIL }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.list).toBe("product-updates");
    expect(body.subscribed).toBe(false);

    const [prefs] = await db
      .select()
      .from(emailPreferences)
      .where(eq(emailPreferences.email, SUB_EMAIL));
    const categories = prefs?.categories as Record<string, boolean>;
    expect(categories?.["product-updates"]).toBe(false);
  });

  it("returns 404 for an unknown list id", async () => {
    const res = await app.request("/v1/lists/no-such-list/subscribe", {
      method: "POST",
      headers: AUTH_HEADER,
      body: JSON.stringify({ email: SUB_EMAIL }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 when neither email nor userId is supplied", async () => {
    const res = await app.request("/v1/lists/product-updates/subscribe", {
      method: "POST",
      headers: AUTH_HEADER,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for a userId-only contact with no resolvable email", async () => {
    const res = await app.request("/v1/lists/product-updates/subscribe", {
      method: "POST",
      headers: AUTH_HEADER,
      body: JSON.stringify({ userId: NOEMAIL_USER }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("email");
  });
});
