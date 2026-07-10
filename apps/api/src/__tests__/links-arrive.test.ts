import { afterAll, describe, expect, it, vi } from "vitest";

// DB-touching test (mirrors links-qr): arrival attribution spans the redirect
// (`hs_ref` append), the arrive endpoint, and stamped click rows — real
// docker TimescaleDB required.
process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";
// hs_ref must coexist with hs_t on personal links — force the token path on.
process.env.TRACKING_IDENTITY_TOKEN = "true";

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

const RUN = `arrive-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

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
      url: "https://example.com/arrive",
      label: `${RUN}-link`,
      ...body,
    }),
  });
  const json = await res.json();
  if (json.id) createdLinkIds.push(json.id);
  return json;
}

function refFromLocation(location: string | null): string | null {
  if (!location) return null;
  return new URL(location).searchParams.get("hs_ref");
}

describe("arrival ref — redirect append (7.1)", () => {
  it("appendRef round-trips through mint, PATCH and responses", async () => {
    const off = await mint({ label: `${RUN}-flag-default` });
    expect(off.appendRef).toBe(false);

    const on = await mint({ label: `${RUN}-flag-on`, appendRef: true });
    expect(on.appendRef).toBe(true);

    const patched = await app.request(`/v1/admin/links/${off.id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ appendRef: true }),
    });
    expect((await patched.json()).appendRef).toBe(true);
  });

  it("opted-in redirects carry hs_ref = the click row id; opted-out carry none", async () => {
    const on = await mint({ label: `${RUN}-ref-on`, appendRef: true });
    const res = await app.request(`/v1/t/c/${on.trackedLinkId}`, {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    const ref = refFromLocation(res.headers.get("location"));
    expect(ref).toMatch(/^[0-9a-f-]{36}$/);

    // The ref IS the click row's id, and destinationUrl stays undecorated.
    const [row] = await db
      .select({
        id: linkClicks.id,
        destinationUrl: linkClicks.destinationUrl,
      })
      .from(linkClicks)
      .where(eq(linkClicks.id, ref ?? ""));
    expect(row?.id).toBe(ref);
    expect(row?.destinationUrl).toBe("https://example.com/arrive");

    const off = await mint({ label: `${RUN}-ref-off` });
    const resOff = await app.request(`/v1/t/c/${off.trackedLinkId}`, {
      redirect: "manual",
    });
    expect(refFromLocation(resOff.headers.get("location"))).toBeNull();
  });

  it("hs_ref coexists with hs_t on a personal link (single URL-build pass)", async () => {
    const personal = await mint({
      label: `${RUN}-personal`,
      type: "personal",
      distinctId: "arrive-contact-1",
      appendRef: true,
    });
    const res = await app.request(`/v1/t/c/${personal.trackedLinkId}`, {
      redirect: "manual",
    });
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.searchParams.get("hs_t")).toBeTruthy();
    expect(location.searchParams.get("hs_ref")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("each hit gets a distinct ref", async () => {
    const link = await mint({ label: `${RUN}-distinct`, appendRef: true });
    const refs = new Set<string | null>();
    for (let i = 0; i < 3; i++) {
      const res = await app.request(`/v1/t/c/${link.trackedLinkId}`, {
        redirect: "manual",
      });
      refs.add(refFromLocation(res.headers.get("location")));
    }
    expect(refs.size).toBe(3);
  });
});
