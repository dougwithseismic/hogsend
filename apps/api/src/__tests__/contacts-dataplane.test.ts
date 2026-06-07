import { afterAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// Contacts routes never push to Hatchet, but createHogsendClient wires the
// engine's real hatchet at construction — mock it so no gRPC client is built.
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

const productUpdates = defineList({
  id: "product-updates",
  name: "Product updates",
  defaultOptIn: false,
});

const container = createHogsendClient({ lists: [productUpdates] });
const app = createApp(container);
const { db } = container;

const AUTH_HEADER = {
  Authorization: `Bearer ${process.env.ADMIN_API_KEY}`,
  "Content-Type": "application/json",
};

const RUN = `cdp-${Date.now()}`;
const EMAIL_ONLY = `${RUN}-emailonly@example.com`;
const USERID = `${RUN}-user`;
const USERID_EMAIL = `${RUN}-user@example.com`;
const LISTS_EMAIL = `${RUN}-lists@example.com`;

afterAll(async () => {
  for (const email of [EMAIL_ONLY, USERID_EMAIL, LISTS_EMAIL]) {
    await db.delete(contacts).where(eq(contacts.email, email));
    await db.delete(emailPreferences).where(eq(emailPreferences.email, email));
  }
  await db.delete(contacts).where(eq(contacts.externalId, USERID));
});

describe("PUT /v1/contacts", () => {
  it("upserts a contact by EMAIL only (external_id null, D1)", async () => {
    const res = await app.request("/v1/contacts", {
      method: "PUT",
      headers: AUTH_HEADER,
      body: JSON.stringify({
        email: EMAIL_ONLY,
        properties: { plan: "free" },
      }),
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.id).toBeTruthy();
    expect(body.created).toBe(true);
    expect(body.linked).toBe(false);

    const [row] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.email, EMAIL_ONLY));
    expect(row).toBeDefined();
    expect(row?.externalId).toBeNull();
    expect((row?.properties as Record<string, unknown>)?.plan).toBe("free");
  });

  it("upserts a contact by userId and merges contactProperties on a re-PUT", async () => {
    const first = await app.request("/v1/contacts", {
      method: "PUT",
      headers: AUTH_HEADER,
      body: JSON.stringify({
        userId: USERID,
        email: USERID_EMAIL,
        properties: { plan: "pro" },
      }),
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.created).toBe(true);

    // A second PUT is upsert/merge — NOT a 409. The new property is merged onto
    // the existing row (decision: resolver is upsert/merge-first).
    const second = await app.request("/v1/contacts", {
      method: "PUT",
      headers: AUTH_HEADER,
      body: JSON.stringify({
        userId: USERID,
        properties: { tier: "gold" },
      }),
    });
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.created).toBe(false);
    expect(secondBody.id).toBe(firstBody.id);

    const [row] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.externalId, USERID));
    const props = row?.properties as Record<string, unknown>;
    expect(props?.plan).toBe("pro");
    expect(props?.tier).toBe("gold");
  });

  it("returns 400 when neither email nor userId is supplied", async () => {
    const res = await app.request("/v1/contacts", {
      method: "PUT",
      headers: AUTH_HEADER,
      body: JSON.stringify({ properties: { x: 1 } }),
    });
    expect(res.status).toBe(400);
  });

  it("writes list membership from the `lists` field (after the resolve)", async () => {
    const res = await app.request("/v1/contacts", {
      method: "PUT",
      headers: AUTH_HEADER,
      body: JSON.stringify({
        email: LISTS_EMAIL,
        lists: { "product-updates": true },
      }),
    });
    expect(res.status).toBe(200);

    // `applyListMembership` flips the category in email_preferences (own table).
    const [prefs] = await db
      .select()
      .from(emailPreferences)
      .where(eq(emailPreferences.email, LISTS_EMAIL));
    expect(prefs).toBeDefined();
    const categories = prefs?.categories as Record<string, boolean>;
    expect(categories?.["product-updates"]).toBe(true);
  });
});

describe("GET /v1/contacts/find", () => {
  it("finds a contact by email", async () => {
    const res = await app.request(
      `/v1/contacts/find?email=${encodeURIComponent(EMAIL_ONLY)}`,
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.contacts).toBeInstanceOf(Array);
    expect(body.contacts).toHaveLength(1);
    expect(body.contacts[0].email).toBe(EMAIL_ONLY);
    expect(body.contacts[0].externalId).toBeNull();
  });

  it("finds a contact by userId", async () => {
    const res = await app.request(`/v1/contacts/find?userId=${USERID}`, {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(
      body.contacts.map((c: { externalId: string }) => c.externalId),
    ).toContain(USERID);
  });

  it("returns 400 with no query key", async () => {
    const res = await app.request("/v1/contacts/find", {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /v1/contacts", () => {
  it("soft-deletes a contact and drops it from find", async () => {
    const res = await app.request("/v1/contacts", {
      method: "DELETE",
      headers: AUTH_HEADER,
      body: JSON.stringify({ email: EMAIL_ONLY }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deleted).toBe(true);

    // Soft delete: the row still exists with deletedAt set...
    const [row] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.email, EMAIL_ONLY));
    expect(row?.deletedAt).not.toBeNull();

    // ...but find (deleted_at IS NULL) no longer returns it.
    const findRes = await app.request(
      `/v1/contacts/find?email=${encodeURIComponent(EMAIL_ONLY)}`,
      { headers: AUTH_HEADER },
    );
    const findBody = await findRes.json();
    expect(findBody.contacts).toHaveLength(0);
  });

  it("returns 404 deleting a contact that does not exist", async () => {
    const res = await app.request("/v1/contacts", {
      method: "DELETE",
      headers: AUTH_HEADER,
      body: JSON.stringify({ email: `${RUN}-ghost@example.com` }),
    });
    expect(res.status).toBe(404);
  });
});
