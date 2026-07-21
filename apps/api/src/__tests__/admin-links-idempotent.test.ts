import { afterAll, describe, expect, it, vi } from "vitest";

// DB-touching test (mirrors admin-links.test.ts): idempotent minting exercises
// the real unique indexes (links_slug_unique + the partial
// links_idempotency_key_unique), so point at the real docker TimescaleDB.
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
const { db } = container;

const AUTH_HEADER = { Authorization: `Bearer ${process.env.ADMIN_API_KEY}` };
const JSON_HEADERS = { ...AUTH_HEADER, "Content-Type": "application/json" };

const RUN = `idemlinks-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// Track everything we create so afterAll can sweep it (link_clicks first, then
// tracked_links, then links — FK order).
const createdLinkIds: string[] = [];
const createdTrackedLinkIds: string[] = [];

function track(body: { id?: string; trackedLinkId?: string | null }): void {
  if (body.id && !createdLinkIds.includes(body.id)) {
    createdLinkIds.push(body.id);
  }
  if (
    body.trackedLinkId &&
    !createdTrackedLinkIds.includes(body.trackedLinkId)
  ) {
    createdTrackedLinkIds.push(body.trackedLinkId);
  }
}

async function mint(payload: Record<string, unknown>): Promise<Response> {
  return app.request("/v1/admin/links", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(payload),
  });
}

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

describe("admin links idempotent minting", () => {
  it("a. slug + SAME url re-mint returns the existing link (existing:true, no new row)", async () => {
    const slug = `${RUN}-a`;
    const url = "https://example.com/idem-slug-same";

    const first = await mint({ url, slug, label: `${RUN}-a` });
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    track(firstBody);
    // A fresh mint is NOT a recovery.
    expect(firstBody.existing).toBe(false);

    const second = await mint({ url, slug, label: `${RUN}-a` });
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    track(secondBody);

    expect(secondBody.id).toBe(firstBody.id);
    expect(secondBody.trackedLinkId).toBe(firstBody.trackedLinkId);
    expect(secondBody.existing).toBe(true);

    // No second links row minted for the slug.
    const rows = await db.select().from(links).where(eq(links.slug, slug));
    expect(rows.length).toBe(1);
  });

  it("b. slug + DIFFERENT url is a 409", async () => {
    const slug = `${RUN}-b`;
    const first = await mint({
      url: "https://example.com/idem-slug-original",
      slug,
    });
    expect(first.status).toBe(200);
    track(await first.json());

    const second = await mint({
      url: "https://example.com/idem-slug-DIFFERENT",
      slug,
    });
    expect(second.status).toBe(409);
  });

  it("c. slug held by an ARCHIVED link is a 409 even for the same url", async () => {
    const slug = `${RUN}-c`;
    const url = "https://example.com/idem-slug-archived";

    const first = await mint({ url, slug });
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    track(firstBody);

    // Archive it — the FULL slug unique index keeps the slug reserved, but the
    // recovery lookup only matches LIVE links, so a re-mint must 409.
    const del = await app.request(`/v1/admin/links/${firstBody.id}`, {
      method: "DELETE",
      headers: AUTH_HEADER,
    });
    expect(del.status).toBe(200);

    const again = await mint({ url, slug });
    expect(again.status).toBe(409);
  });

  it("d. slugless + idempotencyKey with the SAME url twice returns the same link", async () => {
    const idempotencyKey = `${RUN}-d`;
    const url = "https://example.com/idem-key-same";

    const first = await mint({ url, idempotencyKey });
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    track(firstBody);
    expect(firstBody.existing).toBe(false);

    const second = await mint({ url, idempotencyKey });
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    track(secondBody);

    expect(secondBody.id).toBe(firstBody.id);
    expect(secondBody.trackedLinkId).toBe(firstBody.trackedLinkId);
    expect(secondBody.existing).toBe(true);

    const rows = await db
      .select()
      .from(links)
      .where(eq(links.idempotencyKey, idempotencyKey));
    expect(rows.length).toBe(1);
  });

  it("e. slugless + idempotencyKey with a DIFFERENT url is a 409", async () => {
    const idempotencyKey = `${RUN}-e`;

    const first = await mint({
      url: "https://example.com/idem-key-original",
      idempotencyKey,
    });
    expect(first.status).toBe(200);
    track(await first.json());

    const second = await mint({
      url: "https://example.com/idem-key-DIFFERENT",
      idempotencyKey,
    });
    expect(second.status).toBe(409);
  });

  it("f. slug + idempotencyKey together is a 400", async () => {
    const res = await mint({
      url: "https://example.com/idem-both",
      slug: `${RUN}-f`,
      idempotencyKey: `${RUN}-f`,
    });
    expect(res.status).toBe(400);
  });

  it("g. a race of two identical idempotencyKey mints resolves to ONE row, no 500", async () => {
    const idempotencyKey = `${RUN}-g`;
    const url = "https://example.com/idem-race";

    const [resA, resB] = await Promise.all([
      mint({ url, idempotencyKey }),
      mint({ url, idempotencyKey }),
    ]);

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    const bodyA = await resA.json();
    const bodyB = await resB.json();
    track(bodyA);
    track(bodyB);

    expect(bodyA.id).toBe(bodyB.id);
    // Order-independent: exactly one of the two was the fresh mint.
    expect([bodyA.existing, bodyB.existing].sort()).toEqual([false, true]);

    const rows = await db
      .select()
      .from(links)
      .where(eq(links.idempotencyKey, idempotencyKey));
    expect(rows.length).toBe(1);
  });

  it("h. source:'api' is persisted; omitted source defaults to 'studio'", async () => {
    const viaApi = await mint({
      url: "https://example.com/idem-source-api",
      source: "api",
      label: `${RUN}-h-api`,
    });
    expect(viaApi.status).toBe(200);
    const viaApiBody = await viaApi.json();
    track(viaApiBody);
    expect(viaApiBody.source).toBe("api");

    const defaulted = await mint({
      url: "https://example.com/idem-source-default",
      label: `${RUN}-h-default`,
    });
    expect(defaulted.status).toBe(200);
    const defaultedBody = await defaulted.json();
    track(defaultedBody);
    expect(defaultedBody.source).toBe("studio");
  });
});
