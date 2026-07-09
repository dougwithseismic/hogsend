import { afterAll, describe, expect, it, vi } from "vitest";

// DB-touching test (mirrors admin-links): vanity slugs live on `links` with a
// unique index, and the `/l/:slug` redirect drives the same click spine — so
// point at the real docker TimescaleDB.
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

// Slugs are globally unique, so namespace every slug with the run id to keep
// parallel/repeated runs from colliding before afterAll sweeps.
const RUN = `vanity-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const createdLinkIds: string[] = [];

afterAll(async () => {
  for (const id of createdLinkIds) {
    const tracked = await db
      .select({ id: trackedLinks.id })
      .from(trackedLinks)
      .where(eq(trackedLinks.linkId, id));
    for (const t of tracked) {
      await db.delete(linkClicks).where(eq(linkClicks.trackedLinkId, t.id));
    }
    await db.delete(trackedLinks).where(eq(trackedLinks.linkId, id));
    await db.delete(links).where(eq(links.id, id));
  }
});

async function mint(body: Record<string, unknown>) {
  const res = await app.request("/v1/admin/links", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ url: "https://example.com/vanity", ...body }),
  });
  const json = await res.json();
  if (json.id) createdLinkIds.push(json.id);
  return { res, json };
}

describe("vanity slugs — mint + admin CRUD", () => {
  it("POST / mints with a slug and returns slug + vanityUrl", async () => {
    const { res, json } = await mint({ slug: `${RUN}-launch` });
    expect(res.status).toBe(200);
    expect(json.slug).toBe(`${RUN}-launch`);
    expect(json.vanityUrl).toBe(`${env.API_PUBLIC_URL}/l/${RUN}-launch`);
    // The UUID short URL is unchanged — the slug sits OVER it, not instead.
    expect(json.url).toBe(`${env.API_PUBLIC_URL}/v1/t/c/${json.trackedLinkId}`);
  });

  it("POST / normalizes slug case (stored + unique lowercase)", async () => {
    const { res, json } = await mint({ slug: `${RUN}-MiXeD` });
    expect(res.status).toBe(200);
    expect(json.slug).toBe(`${RUN}-mixed`);

    // The uppercase variant of an existing slug is the SAME slug → 409.
    const dup = await app.request("/v1/admin/links", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        url: "https://example.com/vanity",
        slug: `${RUN}-MIXED`,
      }),
    });
    expect(dup.status).toBe(409);
  });

  it("POST / without slug leaves slug + vanityUrl null", async () => {
    const { res, json } = await mint({});
    expect(res.status).toBe(200);
    expect(json.slug).toBeNull();
    expect(json.vanityUrl).toBeNull();
  });

  it("POST / rejects a malformed slug with 400", async () => {
    for (const bad of ["-leading", "trailing-", "has space", "uñicode", ""]) {
      const res = await app.request("/v1/admin/links", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ url: "https://example.com/vanity", slug: bad }),
      });
      expect(res.status, `slug ${JSON.stringify(bad)}`).toBe(400);
    }
  });

  it("POST / returns 409 for a taken slug and mints nothing", async () => {
    const first = await mint({ slug: `${RUN}-taken` });
    expect(first.res.status).toBe(200);

    const before = await db.select({ id: links.id }).from(links);
    const dup = await app.request("/v1/admin/links", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        url: "https://example.com/vanity",
        slug: `${RUN}-taken`,
      }),
    });
    expect(dup.status).toBe(409);
    const after = await db.select({ id: links.id }).from(links);
    // The failed mint left no orphaned links row behind.
    expect(after.length).toBe(before.length);
  });

  it("PATCH /:id sets, replaces, and 409s on a conflicting slug", async () => {
    const a = await mint({ slug: `${RUN}-holder` });
    const b = await mint({});

    // Set a slug on a link minted without one.
    const set = await app.request(`/v1/admin/links/${b.json.id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ slug: `${RUN}-added` }),
    });
    expect(set.status).toBe(200);
    expect((await set.json()).slug).toBe(`${RUN}-added`);

    // Replacing with a slug held by another link → 409, slug unchanged.
    const clash = await app.request(`/v1/admin/links/${b.json.id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ slug: `${RUN}-holder` }),
    });
    expect(clash.status).toBe(409);
    const [row] = await db
      .select({ slug: links.slug })
      .from(links)
      .where(eq(links.id, b.json.id));
    expect(row?.slug).toBe(`${RUN}-added`);

    // Malformed slug on PATCH → 400.
    const bad = await app.request(`/v1/admin/links/${a.json.id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ slug: "no good" }),
    });
    expect(bad.status).toBe(400);
  });

  it("PATCH /:id with slug null clears it and frees it for reuse", async () => {
    const a = await mint({ slug: `${RUN}-freeable` });

    const clear = await app.request(`/v1/admin/links/${a.json.id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ slug: null }),
    });
    expect(clear.status).toBe(200);
    const cleared = await clear.json();
    expect(cleared.slug).toBeNull();
    expect(cleared.vanityUrl).toBeNull();

    // The freed slug is mintable by a new link.
    const reuse = await mint({ slug: `${RUN}-freeable` });
    expect(reuse.res.status).toBe(200);
    expect(reuse.json.slug).toBe(`${RUN}-freeable`);
  });

  it("GET / list + GET /:id both carry slug + vanityUrl", async () => {
    const { json } = await mint({
      slug: `${RUN}-listed`,
      label: `${RUN}-listed`,
    });

    const detail = await app.request(`/v1/admin/links/${json.id}`, {
      headers: AUTH_HEADER,
    });
    const detailBody = await detail.json();
    expect(detailBody.slug).toBe(`${RUN}-listed`);
    expect(detailBody.vanityUrl).toBe(`${env.API_PUBLIC_URL}/l/${RUN}-listed`);

    const list = await app.request("/v1/admin/links?limit=200", {
      headers: AUTH_HEADER,
    });
    const listBody = await list.json();
    const mine = listBody.links.find((l: { id: string }) => l.id === json.id);
    expect(mine?.slug).toBe(`${RUN}-listed`);
  });
});
