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
const {
  createApp,
  createHogsendClient,
  ensureQrTrackedLink,
  QR_TRACKED_SOURCE,
} = await import("@hogsend/engine");

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

describe("QR scan spine — ensureQrTrackedLink", () => {
  it("lazily mints the QR row once and is idempotent", async () => {
    const link = await mint();

    const first = await ensureQrTrackedLink({ db, linkId: link.id });
    expect(first).not.toBeNull();
    expect(first?.created).toBe(true);

    const second = await ensureQrTrackedLink({ db, linkId: link.id });
    expect(second?.created).toBe(false);
    expect(second?.trackedLinkId).toBe(first?.trackedLinkId);

    // Exactly one QR row exists; the canonical redirect row is untouched.
    const qrRows = await db
      .select({ id: trackedLinks.id, originalUrl: trackedLinks.originalUrl })
      .from(trackedLinks)
      .where(
        and(
          eq(trackedLinks.linkId, link.id),
          eq(trackedLinks.source, QR_TRACKED_SOURCE),
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
        ensureQrTrackedLink({ db, linkId: link.id }),
      ),
    );
    const ids = new Set(results.map((r) => r?.trackedLinkId));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r?.created).length).toBe(1);

    const qrRows = await db
      .select({ id: trackedLinks.id })
      .from(trackedLinks)
      .where(
        and(
          eq(trackedLinks.linkId, link.id),
          eq(trackedLinks.source, QR_TRACKED_SOURCE),
        ),
      );
    expect(qrRows.length).toBe(1);
  });

  it("returns null for an unknown link", async () => {
    const result = await ensureQrTrackedLink({
      db,
      linkId: "00000000-0000-0000-0000-000000000000",
    });
    expect(result).toBeNull();
  });

  it("copies distinctId onto a personal link's QR row", async () => {
    const link = await mint({
      label: `${RUN}-personal`,
      type: "personal",
      distinctId: "qr-contact-1",
    });

    const qr = await ensureQrTrackedLink({ db, linkId: link.id });
    const [row] = await db
      .select({ distinctId: trackedLinks.distinctId })
      .from(trackedLinks)
      .where(eq(trackedLinks.id, qr?.trackedLinkId ?? ""));
    expect(row?.distinctId).toBe("qr-contact-1");
  });
});

describe("QR scan spine — counts + retarget", () => {
  it("a scan increments scanCount; clickCount stays the all-paths total", async () => {
    const link = await mint({ label: `${RUN}-counts` });
    const qr = await ensureQrTrackedLink({ db, linkId: link.id });

    // One click on the canonical row, two scans through the QR row — all via
    // the same public click route.
    await app.request(`/v1/t/c/${link.trackedLinkId}`, { redirect: "manual" });
    const scan1 = await app.request(`/v1/t/c/${qr?.trackedLinkId}`, {
      redirect: "manual",
    });
    await app.request(`/v1/t/c/${qr?.trackedLinkId}`, { redirect: "manual" });
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
    const qr = await ensureQrTrackedLink({ db, linkId: link.id });

    const next = "https://example.com/qr-retargeted";
    const patch = await app.request(`/v1/admin/links/${link.id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ originalUrl: next }),
    });
    expect(patch.status).toBe(200);

    // The scan URL (what a printed QR encodes) now 302s to the new target.
    const scan = await app.request(`/v1/t/c/${qr?.trackedLinkId}`, {
      redirect: "manual",
    });
    expect(scan.headers.get("location")).toBe(next);
  });

  it("the vanity route never resolves through the QR row", async () => {
    const link = await mint({
      label: `${RUN}-vanity-canonical`,
      slug: `${RUN}-vanity`,
    });
    await ensureQrTrackedLink({ db, linkId: link.id });

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
          eq(trackedLinks.source, QR_TRACKED_SOURCE),
        ),
      );
    expect(qrRow?.clickCount).toBe(0);
  });
});
