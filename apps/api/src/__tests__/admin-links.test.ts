import { afterAll, describe, expect, it, vi } from "vitest";

// DB-touching test (mirrors admin-suppressions + link-tracker-email-invariant):
// the admin links CRUD mints `links` + `tracked_links` rows and reads click
// counts back off `tracked_links`, so point at the real docker TimescaleDB.
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

vi.mock("../workflows/send-email.js", () => ({
  sendEmailTask: { run: vi.fn(), runNoWait: vi.fn() },
}));

const { linkClicks, links, trackedLinks } = await import("@hogsend/db");
const { eq } = await import("drizzle-orm");
const { createApp, createHogsendClient } = await import("@hogsend/engine");

const container = createHogsendClient();
const app = createApp(container);
const { db, env } = container;

const AUTH_HEADER = { Authorization: `Bearer ${process.env.ADMIN_API_KEY}` };
const JSON_HEADERS = { ...AUTH_HEADER, "Content-Type": "application/json" };

const RUN = `adminlinks-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// Track everything we create so afterAll can sweep it (link_clicks first, then
// tracked_links, then links — FK order).
const createdLinkIds: string[] = [];
const createdTrackedLinkIds: string[] = [];

afterAll(async () => {
  for (const id of createdTrackedLinkIds) {
    await db.delete(linkClicks).where(eq(linkClicks.trackedLinkId, id));
    await db.delete(trackedLinks).where(eq(trackedLinks.id, id));
  }
  for (const id of createdLinkIds) {
    await db.delete(trackedLinks).where(eq(trackedLinks.linkId, id));
    await db.delete(links).where(eq(links.id, id));
  }
});

describe("admin links CRUD", () => {
  it("returns 401 without auth", async () => {
    const res = await app.request("/v1/admin/links");
    expect(res.status).toBe(401);
  });

  it("POST / mints a public link and returns the short URL", async () => {
    const res = await app.request("/v1/admin/links", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        url: "https://example.com/managed-public",
        type: "public",
        label: `${RUN}-public`,
        campaign: RUN,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    createdLinkIds.push(body.id);
    createdTrackedLinkIds.push(body.trackedLinkId);

    expect(body.originalUrl).toBe("https://example.com/managed-public");
    expect(body.type).toBe("public");
    expect(body.label).toBe(`${RUN}-public`);
    expect(body.campaign).toBe(RUN);
    expect(body.source).toBe("studio");
    // Share-safe invariant: a public link NEVER carries a person token.
    expect(body.distinctId).toBeNull();
    // The short redirect URL points at the minted tracked row.
    expect(body.url).toBe(`${env.API_PUBLIC_URL}/v1/t/c/${body.trackedLinkId}`);
    // The minting actor (an API key here) is recorded.
    expect(body.createdBy).not.toBeNull();
  });

  it("POST / drops distinctId for a public link, keeps it for personal", async () => {
    const pub = await app.request("/v1/admin/links", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        url: "https://example.com/public-no-stitch",
        type: "public",
        distinctId: "should-be-dropped",
        label: `${RUN}-pub-nostitch`,
      }),
    });
    const pubBody = await pub.json();
    createdLinkIds.push(pubBody.id);
    createdTrackedLinkIds.push(pubBody.trackedLinkId);
    expect(pubBody.distinctId).toBeNull();

    const personal = await app.request("/v1/admin/links", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        url: "https://example.com/personal-stitch",
        type: "personal",
        distinctId: "contact-key-123",
        label: `${RUN}-personal`,
      }),
    });
    const personalBody = await personal.json();
    createdLinkIds.push(personalBody.id);
    createdTrackedLinkIds.push(personalBody.trackedLinkId);
    expect(personalBody.type).toBe("personal");
    expect(personalBody.distinctId).toBe("contact-key-123");
  });

  it("POST / rejects a non-http(s) destination", async () => {
    const res = await app.request("/v1/admin/links", {
      method: "POST",
      headers: JSON_HEADERS,
      // Caught by zod .url() first; a javascript: scheme that passes URL parse
      // would be caught by mintLink's open-redirect guard (also a 400).
      body: JSON.stringify({ url: "ftp://example.com/x" }),
    });
    expect(res.status).toBe(400);
  });

  it("GET / lists non-archived links newest-first with click counts", async () => {
    const res = await app.request("/v1/admin/links?limit=200", {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.links).toBeInstanceOf(Array);

    const mine = body.links.filter((l: { label: string | null }) =>
      l.label?.startsWith(RUN),
    );
    expect(mine.length).toBeGreaterThanOrEqual(1);
    const sample = mine[0];
    expect(sample).toHaveProperty("clickCount");
    expect(typeof sample.clickCount).toBe("number");
    expect(sample.url).toContain(`${env.API_PUBLIC_URL}/v1/t/c/`);
    expect(sample.archivedAt).toBeNull();
  });

  it("GET /:id returns the link with its recent clicks and a live click count", async () => {
    const created = await app.request("/v1/admin/links", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        url: "https://example.com/with-clicks",
        label: `${RUN}-clicked`,
      }),
    });
    const createdBody = await created.json();
    createdLinkIds.push(createdBody.id);
    createdTrackedLinkIds.push(createdBody.trackedLinkId);

    // Drive a real click through the public click route.
    const click = await app.request(`/v1/t/c/${createdBody.trackedLinkId}`, {
      redirect: "manual",
    });
    expect(click.status).toBe(302);

    const res = await app.request(`/v1/admin/links/${createdBody.id}`, {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(createdBody.id);
    // Click count is computed ON READ from tracked_links.click_count.
    expect(body.clickCount).toBe(1);
    expect(body.clicks).toBeInstanceOf(Array);
    expect(body.clicks.length).toBe(1);
    expect(body.clicks[0]).toHaveProperty("clickedAt");
  });

  it("GET /:id returns 404 for an unknown id", async () => {
    const res = await app.request(
      "/v1/admin/links/00000000-0000-0000-0000-000000000000",
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(404);
  });

  it("PATCH /:id edits label + campaign only", async () => {
    const created = await app.request("/v1/admin/links", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        url: "https://example.com/to-edit",
        label: `${RUN}-before`,
        campaign: `${RUN}-c1`,
      }),
    });
    const createdBody = await created.json();
    createdLinkIds.push(createdBody.id);
    createdTrackedLinkIds.push(createdBody.trackedLinkId);

    const res = await app.request(`/v1/admin/links/${createdBody.id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ label: `${RUN}-after`, campaign: `${RUN}-c2` }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.label).toBe(`${RUN}-after`);
    expect(body.campaign).toBe(`${RUN}-c2`);
    // The destination URL is immutable via PATCH.
    expect(body.originalUrl).toBe("https://example.com/to-edit");
  });

  it("DELETE /:id archives (soft-delete) and the link drops off the list", async () => {
    const created = await app.request("/v1/admin/links", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        url: "https://example.com/to-archive",
        label: `${RUN}-archive`,
      }),
    });
    const createdBody = await created.json();
    createdLinkIds.push(createdBody.id);
    createdTrackedLinkIds.push(createdBody.trackedLinkId);

    const del = await app.request(`/v1/admin/links/${createdBody.id}`, {
      method: "DELETE",
      headers: AUTH_HEADER,
    });
    expect(del.status).toBe(200);
    const delBody = await del.json();
    expect(delBody.id).toBe(createdBody.id);
    expect(delBody.archivedAt).not.toBeNull();

    // The row is NOT hard-deleted — it still exists with archived_at set.
    const [row] = await db
      .select({ archivedAt: links.archivedAt })
      .from(links)
      .where(eq(links.id, createdBody.id));
    expect(row?.archivedAt).not.toBeNull();

    // ...and no longer appears in the (non-archived) list.
    const list = await app.request("/v1/admin/links?limit=200", {
      headers: AUTH_HEADER,
    });
    const listBody = await list.json();
    const ids = listBody.links.map((l: { id: string }) => l.id);
    expect(ids).not.toContain(createdBody.id);

    // A second archive is a 404 (the first already archived it).
    const again = await app.request(`/v1/admin/links/${createdBody.id}`, {
      method: "DELETE",
      headers: AUTH_HEADER,
    });
    expect(again.status).toBe(404);
  });
});
