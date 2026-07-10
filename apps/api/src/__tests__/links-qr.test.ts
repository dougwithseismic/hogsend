import { afterAll, describe, expect, it, vi } from "vitest";

// DB-touching test (mirrors admin-links): the QR scan spine is a second
// tracked_links row per managed link, guarded by a partial unique index — so
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
const { and, eq } = await import("drizzle-orm");
const { createApp, createHogsendClient } = await import("@hogsend/engine");

const container = createHogsendClient();
const app = createApp(container);
const { db } = container;

const AUTH_HEADER = { Authorization: `Bearer ${process.env.ADMIN_API_KEY}` };
const JSON_HEADERS = { ...AUTH_HEADER, "Content-Type": "application/json" };

const RUN = `qrspine-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

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

// The 'qr' source marker + lazy mint are engine-internal — tests drive them
// through the public admin endpoint (`GET /:id/qr` lazy-mints the scan row)
// and read the row back from the DB.
const QR_SOURCE = "qr";

async function qrRowOf(linkId: string) {
  const [row] = await db
    .select({
      id: trackedLinks.id,
      distinctId: trackedLinks.distinctId,
      originalUrl: trackedLinks.originalUrl,
      clickCount: trackedLinks.clickCount,
    })
    .from(trackedLinks)
    .where(
      and(eq(trackedLinks.linkId, linkId), eq(trackedLinks.source, QR_SOURCE)),
    );
  return row;
}

/** Touch the QR endpoint (lazy-mints the scan row) and return that row. */
async function ensureQrViaEndpoint(linkId: string) {
  const res = await app.request(`/v1/admin/links/${linkId}/qr`, {
    headers: AUTH_HEADER,
  });
  expect(res.status).toBe(200);
  return qrRowOf(linkId);
}

async function mint(body: Record<string, unknown> = {}) {
  const res = await app.request("/v1/admin/links", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      url: "https://example.com/qr-spine",
      label: `${RUN}-link`,
      ...body,
    }),
  });
  const json = await res.json();
  if (json.id) createdLinkIds.push(json.id);
  return json;
}

describe("QR scan spine — lazy mint via the QR endpoint", () => {
  it("lazily mints the QR row once and is idempotent", async () => {
    const link = await mint();

    expect(await qrRowOf(link.id)).toBeUndefined();
    const first = await ensureQrViaEndpoint(link.id);
    expect(first).toBeDefined();

    const second = await ensureQrViaEndpoint(link.id);
    expect(second?.id).toBe(first?.id);

    // Exactly one QR row exists; the canonical redirect row is untouched.
    const qrRows = await db
      .select({ id: trackedLinks.id, originalUrl: trackedLinks.originalUrl })
      .from(trackedLinks)
      .where(
        and(
          eq(trackedLinks.linkId, link.id),
          eq(trackedLinks.source, QR_SOURCE),
        ),
      );
    expect(qrRows.length).toBe(1);
    expect(qrRows[0]?.originalUrl).toBe("https://example.com/qr-spine");

    const allRows = await db
      .select({ id: trackedLinks.id })
      .from(trackedLinks)
      .where(eq(trackedLinks.linkId, link.id));
    expect(allRows.length).toBe(2);
  });

  it("mints exactly one row under a concurrent race", async () => {
    const link = await mint({ label: `${RUN}-race` });

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        app.request(`/v1/admin/links/${link.id}/qr`, { headers: AUTH_HEADER }),
      ),
    );
    for (const r of results) expect(r.status).toBe(200);

    const qrRows = await db
      .select({ id: trackedLinks.id })
      .from(trackedLinks)
      .where(
        and(
          eq(trackedLinks.linkId, link.id),
          eq(trackedLinks.source, QR_SOURCE),
        ),
      );
    expect(qrRows.length).toBe(1);
  });

  it("404s for an unknown link (no phantom row minted)", async () => {
    const res = await app.request(
      "/v1/admin/links/00000000-0000-0000-0000-000000000000/qr",
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(404);
  });

  it("copies distinctId onto a personal link's QR row", async () => {
    const link = await mint({
      label: `${RUN}-personal`,
      type: "personal",
      distinctId: "qr-contact-1",
    });

    const qr = await ensureQrViaEndpoint(link.id);
    expect(qr?.distinctId).toBe("qr-contact-1");
  });
});

describe("QR scan spine — counts + retarget", () => {
  it("a scan increments scanCount; clickCount stays the all-paths total", async () => {
    const link = await mint({ label: `${RUN}-counts` });
    const qr = await ensureQrViaEndpoint(link.id);

    // One click on the canonical row, two scans through the QR row — all via
    // the same public click route.
    await app.request(`/v1/t/c/${link.trackedLinkId}`, { redirect: "manual" });
    const scan1 = await app.request(`/v1/t/c/${qr?.id}`, {
      redirect: "manual",
    });
    await app.request(`/v1/t/c/${qr?.id}`, { redirect: "manual" });
    expect(scan1.status).toBe(302);
    expect(scan1.headers.get("location")).toBe("https://example.com/qr-spine");

    const res = await app.request(`/v1/admin/links/${link.id}`, {
      headers: AUTH_HEADER,
    });
    const body = await res.json();
    expect(body.scanCount).toBe(2);
    expect(body.clickCount).toBe(3);
    // The canonical redirect row keeps its identity — the QR row never becomes
    // the link's trackedLinkId/url.
    expect(body.trackedLinkId).toBe(link.trackedLinkId);
  });

  it("PATCH re-target updates the QR row too (printed codes follow)", async () => {
    const link = await mint({ label: `${RUN}-retarget` });
    const qr = await ensureQrViaEndpoint(link.id);

    const next = "https://example.com/qr-retargeted";
    const patch = await app.request(`/v1/admin/links/${link.id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ originalUrl: next }),
    });
    expect(patch.status).toBe(200);

    // The scan URL (what a printed QR encodes) now 302s to the new target.
    const scan = await app.request(`/v1/t/c/${qr?.id}`, {
      redirect: "manual",
    });
    expect(scan.headers.get("location")).toBe(next);
  });

  it("GET /:id/qr renders SVG by default, lazy-mints the scan row, and is deterministic", async () => {
    const link = await mint({ label: `${RUN}-qr-endpoint` });

    // No QR row yet — the endpoint mints it.
    const before = await db
      .select({ id: trackedLinks.id })
      .from(trackedLinks)
      .where(
        and(
          eq(trackedLinks.linkId, link.id),
          eq(trackedLinks.source, QR_SOURCE),
        ),
      );
    expect(before.length).toBe(0);

    const res = await app.request(`/v1/admin/links/${link.id}/qr`, {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/svg+xml");
    const svg = await res.text();
    expect(svg).toContain("<svg");

    const [qrRow] = await db
      .select({ id: trackedLinks.id })
      .from(trackedLinks)
      .where(
        and(
          eq(trackedLinks.linkId, link.id),
          eq(trackedLinks.source, QR_SOURCE),
        ),
      );
    expect(qrRow).toBeDefined();

    // Deterministic: same link → byte-identical SVG (same encoded scan URL).
    const again = await app.request(`/v1/admin/links/${link.id}/qr`, {
      headers: AUTH_HEADER,
    });
    expect(await again.text()).toBe(svg);

    // The encoded payload is the DURABLE UID URL — scanning it (driving the
    // scan URL through the click route) increments scanCount.
    await app.request(`/v1/t/c/${qrRow?.id}`, { redirect: "manual" });
    const detail = await app.request(`/v1/admin/links/${link.id}`, {
      headers: AUTH_HEADER,
    });
    expect((await detail.json()).scanCount).toBe(1);
  });

  it("GET /:id/qr?format=png&size=256 renders a PNG at the requested size", async () => {
    const link = await mint({ label: `${RUN}-qr-png` });

    const res = await app.request(
      `/v1/admin/links/${link.id}/qr?format=png&size=256`,
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/png");

    const bytes = new Uint8Array(await res.arrayBuffer());
    // PNG signature…
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    // …and IHDR width (bytes 16-19, big-endian) honors `size`.
    const width = new DataView(bytes.buffer).getUint32(16);
    expect(width).toBe(256);
  });

  it("GET /:id/qr?transparent=true renders a transparent background in both formats", async () => {
    const link = await mint({ label: `${RUN}-qr-transparent` });

    // SVG: transparent output differs from opaque and drops the light fill.
    const opaque = await app.request(`/v1/admin/links/${link.id}/qr`, {
      headers: AUTH_HEADER,
    });
    const transparent = await app.request(
      `/v1/admin/links/${link.id}/qr?transparent=true`,
      { headers: AUTH_HEADER },
    );
    expect(transparent.status).toBe(200);
    const opaqueSvg = await opaque.text();
    const transparentSvg = await transparent.text();
    expect(transparentSvg).toContain("<svg");
    expect(transparentSvg).not.toBe(opaqueSvg);
    // qrcode renders the light modules as a filled path; "#ffffff" disappears
    // when the light color is fully transparent.
    expect(opaqueSvg).toContain("#ffffff");
    expect(transparentSvg).not.toContain("#ffffff");

    // PNG: still a valid PNG signature, distinct bytes from the opaque render.
    const opaquePng = new Uint8Array(
      await (
        await app.request(`/v1/admin/links/${link.id}/qr?format=png&size=256`, {
          headers: AUTH_HEADER,
        })
      ).arrayBuffer(),
    );
    const transparentPng = new Uint8Array(
      await (
        await app.request(
          `/v1/admin/links/${link.id}/qr?format=png&size=256&transparent=true`,
          { headers: AUTH_HEADER },
        )
      ).arrayBuffer(),
    );
    expect(Array.from(transparentPng.slice(0, 4))).toEqual([
      0x89, 0x50, 0x4e, 0x47,
    ]);
    expect(Buffer.from(transparentPng).equals(Buffer.from(opaquePng))).toBe(
      false,
    );
  });

  it("GET /:id/qr returns 404 for an unknown link and 401 without auth", async () => {
    const missing = await app.request(
      "/v1/admin/links/00000000-0000-0000-0000-000000000000/qr",
      { headers: AUTH_HEADER },
    );
    expect(missing.status).toBe(404);

    const link = await mint({ label: `${RUN}-qr-auth` });
    const unauthed = await app.request(`/v1/admin/links/${link.id}/qr`);
    expect(unauthed.status).toBe(401);
  });

  it("description round-trips through mint, PATCH and responses", async () => {
    const link = await mint({
      label: `${RUN}-desc`,
      description: "Sticker on the workshop door",
    });
    expect(link.description).toBe("Sticker on the workshop door");

    const patched = await app.request(`/v1/admin/links/${link.id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ description: "Moved to the front window" }),
    });
    expect((await patched.json()).description).toBe(
      "Moved to the front window",
    );

    // null clears it.
    const cleared = await app.request(`/v1/admin/links/${link.id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ description: null }),
    });
    expect((await cleared.json()).description).toBeNull();
  });

  it("stamps the live destination on every click row (per-hit provenance)", async () => {
    const link = await mint({
      label: `${RUN}-provenance`,
      url: "https://example.com/qr-first-target",
    });
    const qr = await ensureQrViaEndpoint(link.id);

    // One click + one scan against the FIRST destination…
    await app.request(`/v1/t/c/${link.trackedLinkId}`, { redirect: "manual" });
    await app.request(`/v1/t/c/${qr?.id}`, { redirect: "manual" });

    // …re-target…
    await app.request(`/v1/admin/links/${link.id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        originalUrl: "https://example.com/qr-second-target",
      }),
    });

    // …then one more scan against the SECOND destination.
    await app.request(`/v1/t/c/${qr?.id}`, { redirect: "manual" });

    const rows = await db
      .select({
        destinationUrl: linkClicks.destinationUrl,
        trackedLinkId: linkClicks.trackedLinkId,
      })
      .from(linkClicks)
      .innerJoin(trackedLinks, eq(linkClicks.trackedLinkId, trackedLinks.id))
      .where(eq(trackedLinks.linkId, link.id));

    const first = rows.filter(
      (r) => r.destinationUrl === "https://example.com/qr-first-target",
    );
    const second = rows.filter(
      (r) => r.destinationUrl === "https://example.com/qr-second-target",
    );
    expect(rows.length).toBe(3);
    expect(first.length).toBe(2);
    expect(second.length).toBe(1);
    // The post-retarget scan rode the QR row.
    expect(second[0]?.trackedLinkId).toBe(qr?.id);
  });

  it("GET /:id groups stats per destination across a re-target", async () => {
    const link = await mint({
      label: `${RUN}-destinations`,
      url: "https://example.com/dest-a",
    });
    const qr = await ensureQrViaEndpoint(link.id);

    // Destination A: two clicks + one scan.
    await app.request(`/v1/t/c/${link.trackedLinkId}`, { redirect: "manual" });
    await app.request(`/v1/t/c/${link.trackedLinkId}`, { redirect: "manual" });
    await app.request(`/v1/t/c/${qr?.id}`, { redirect: "manual" });

    await app.request(`/v1/admin/links/${link.id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ originalUrl: "https://example.com/dest-b" }),
    });

    // Destination B: one scan only.
    await app.request(`/v1/t/c/${qr?.id}`, { redirect: "manual" });

    const res = await app.request(`/v1/admin/links/${link.id}`, {
      headers: AUTH_HEADER,
    });
    const body = await res.json();

    expect(body.destinations.length).toBe(2);
    // Newest activity first — the current destination leads.
    const [current, previous] = body.destinations;
    expect(current.url).toBe("https://example.com/dest-b");
    expect(current.clicks).toBe(1);
    expect(current.scans).toBe(1);
    expect(previous.url).toBe("https://example.com/dest-a");
    expect(previous.clicks).toBe(3);
    expect(previous.scans).toBe(1);
    expect(new Date(previous.firstAt).getTime()).toBeLessThanOrEqual(
      new Date(previous.lastAt).getTime(),
    );

    // Top-level counters stay the all-time totals.
    expect(body.clickCount).toBe(4);
    expect(body.scanCount).toBe(2);
  });

  it("GET /?hasQr=true lists only links whose QR row exists", async () => {
    const withQr = await mint({ label: `${RUN}-lens-with` });
    const withoutQr = await mint({ label: `${RUN}-lens-without` });
    await ensureQrViaEndpoint(withQr.id);

    const res = await app.request("/v1/admin/links?hasQr=true&limit=200", {
      headers: AUTH_HEADER,
    });
    const ids = (await res.json()).links.map((l: { id: string }) => l.id);
    expect(ids).toContain(withQr.id);
    expect(ids).not.toContain(withoutQr.id);

    // Without the filter both appear.
    const all = await app.request("/v1/admin/links?limit=200", {
      headers: AUTH_HEADER,
    });
    const allIds = (await all.json()).links.map((l: { id: string }) => l.id);
    expect(allIds).toContain(withQr.id);
    expect(allIds).toContain(withoutQr.id);
  });

  it("the vanity route never resolves through the QR row", async () => {
    const link = await mint({
      label: `${RUN}-vanity-canonical`,
      slug: `${RUN}-vanity`,
    });
    await ensureQrViaEndpoint(link.id);

    await app.request(`/l/${RUN}-vanity`, { redirect: "manual" });

    // The vanity click landed on the canonical row, not the QR row.
    const [canonical] = await db
      .select({ clickCount: trackedLinks.clickCount })
      .from(trackedLinks)
      .where(eq(trackedLinks.id, link.trackedLinkId));
    expect(canonical?.clickCount).toBe(1);

    const [qrRow] = await db
      .select({ clickCount: trackedLinks.clickCount })
      .from(trackedLinks)
      .where(
        and(
          eq(trackedLinks.linkId, link.id),
          eq(trackedLinks.source, QR_SOURCE),
        ),
      );
    expect(qrRow?.clickCount).toBe(0);
  });
});
