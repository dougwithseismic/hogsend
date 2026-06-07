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

const { contacts, emailPreferences } = await import("@hogsend/db");
const { eq } = await import("drizzle-orm");
const { createApp, createHogsendClient, defineList } = await import(
  "@hogsend/engine"
);

// `product-updates` is opt-in (defaultOptIn:false): subscribe must set the
// category to exactly `true`, unsubscribe to `false`.
const productUpdates = defineList({
  id: "product-updates",
  name: "Product updates",
  description: "Occasional product news.",
  defaultOptIn: false,
});

const container = createHogsendClient({ lists: [productUpdates] });
const app = createApp(container);
const { db } = container;

const AUTH_HEADER = {
  Authorization: `Bearer ${process.env.ADMIN_API_KEY}`,
  "Content-Type": "application/json",
};

const RUN = `ldp-${Date.now()}`;
const SUB_EMAIL = `${RUN}-sub@example.com`;
const NOEMAIL_USER = `${RUN}-noemail`;

beforeAll(async () => {
  // A contact with an external_id but NO email — list writes require a
  // resolvable email (risk 10), so this drives the 400 path.
  await db
    .insert(contacts)
    .values({ externalId: NOEMAIL_USER, email: null })
    .onConflictDoNothing();
});

afterAll(async () => {
  await db
    .delete(emailPreferences)
    .where(eq(emailPreferences.email, SUB_EMAIL));
  await db.delete(contacts).where(eq(contacts.email, SUB_EMAIL));
  await db.delete(contacts).where(eq(contacts.externalId, NOEMAIL_USER));
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
