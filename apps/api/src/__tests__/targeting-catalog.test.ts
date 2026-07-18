import type { HogsendClient } from "@hogsend/engine";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { bucketMemberships, contacts } = await import("@hogsend/db");
const { eq } = await import("drizzle-orm");
const { createApp, createHogsendClient } = await import("@hogsend/engine");

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

const container = createHogsendClient({ overrides: { hatchet: mockHatchet } });
const app = createApp(container);
const { db } = container;

const AUTH_ADMIN = { Authorization: `Bearer ${process.env.ADMIN_API_KEY}` };
const JSON_ADMIN = { ...AUTH_ADMIN, "Content-Type": "application/json" };

const RUN = `catalog-${Date.now()}`;
const PROP_KEY = `${RUN}_plan`;
const PROP_VALUE = "pro";
const EXTERNAL_ID = `${RUN}-contact`;
const BUCKET_ID = `${RUN}-bucket`;

beforeAll(async () => {
  await db.insert(contacts).values({
    externalId: EXTERNAL_ID,
    properties: { [PROP_KEY]: PROP_VALUE },
  });
  // A live, active membership keyed on the contact's logical key so a `bucket`
  // targeting leaf resolves for the count estimate.
  await db.insert(bucketMemberships).values({
    userId: EXTERNAL_ID,
    bucketId: BUCKET_ID,
    status: "active",
  });
});

afterAll(async () => {
  await db
    .delete(bucketMemberships)
    .where(eq(bucketMemberships.userId, EXTERNAL_ID));
  await db.delete(contacts).where(eq(contacts.externalId, EXTERNAL_ID));
});

describe("GET /v1/admin/targeting/catalog", () => {
  it("returns the operator vocabulary with labels + unary flags", async () => {
    const res = await app.request("/v1/admin/targeting/catalog", {
      headers: AUTH_ADMIN,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      properties: string[];
      operators: Array<{ value: string; label: string; unary: boolean }>;
    };

    // All 9 property operators are present.
    const values = body.operators.map((o) => o.value).sort();
    expect(values).toEqual(
      [
        "contains",
        "eq",
        "exists",
        "gt",
        "gte",
        "lt",
        "lte",
        "neq",
        "not_exists",
      ].sort(),
    );

    // exists/not_exists are unary; eq is not; labels are human-readable.
    const byValue = new Map(body.operators.map((o) => [o.value, o]));
    expect(byValue.get("exists")?.unary).toBe(true);
    expect(byValue.get("not_exists")?.unary).toBe(true);
    expect(byValue.get("eq")?.unary).toBe(false);
    expect(byValue.get("not_exists")?.label).toBe("is not set");
    expect(byValue.get("eq")?.label).toBe("equals");
  });

  it("surfaces distinct contact-property keys (sorted)", async () => {
    const res = await app.request("/v1/admin/targeting/catalog", {
      headers: AUTH_ADMIN,
    });
    const body = (await res.json()) as { properties: string[] };

    expect(body.properties).toContain(PROP_KEY);
    // Sorted ascending.
    const sorted = [...body.properties].sort();
    expect(body.properties).toEqual(sorted);
  });

  it("returns the richer targeting sources (buckets/journeys/stages/events/campaigns)", async () => {
    const res = await app.request("/v1/admin/targeting/catalog", {
      headers: AUTH_ADMIN,
    });
    const body = (await res.json()) as {
      buckets: Array<{ id: string; name: string }>;
      journeys: Array<{ id: string; name: string }>;
      dealStages: string[];
      events: Array<{ name: string }>;
      campaigns: Array<{ id: string; name: string }>;
    };

    // All five new sources are present as arrays.
    expect(Array.isArray(body.buckets)).toBe(true);
    expect(Array.isArray(body.journeys)).toBe(true);
    expect(Array.isArray(body.events)).toBe(true);
    expect(Array.isArray(body.campaigns)).toBe(true);

    // Deal stages are the canonical ladder + the terminal "lost".
    expect(body.dealStages).toContain("lead");
    expect(body.dealStages).toContain("sold");
    expect(body.dealStages).toContain("lost");
  });

  it("requires admin auth", async () => {
    const res = await app.request("/v1/admin/targeting/catalog");
    expect(res.status).toBe(401);
  });
});

describe("POST /v1/admin/targeting/count", () => {
  it("estimates matches for a property tree over the seeded contact", async () => {
    const res = await app.request("/v1/admin/targeting/count", {
      method: "POST",
      headers: JSON_ADMIN,
      body: JSON.stringify({
        targeting: {
          type: "property",
          property: PROP_KEY,
          operator: "eq",
          value: PROP_VALUE,
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      matched: number;
      sampled: number;
      estimatedTotal: number;
    };

    // The just-inserted contact is the most-recently-updated row, so it is in
    // the sample and matches the property leaf.
    expect(body.sampled).toBeGreaterThan(0);
    expect(body.matched).toBeGreaterThanOrEqual(1);
    // matched ≤ sampled, and the scaled estimate is at least the sample hits.
    expect(body.matched).toBeLessThanOrEqual(body.sampled);
    expect(body.estimatedTotal).toBeGreaterThanOrEqual(body.matched);
  });

  it("resolves a bucket leaf for the estimate (server mode)", async () => {
    const res = await app.request("/v1/admin/targeting/count", {
      method: "POST",
      headers: JSON_ADMIN,
      body: JSON.stringify({
        targeting: { type: "bucket", bucketId: BUCKET_ID },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      matched: number;
      sampled: number;
      estimatedTotal: number;
    };

    // Exactly the seeded contact carries this run-unique bucket membership.
    expect(body.matched).toBeGreaterThanOrEqual(1);
    expect(body.matched).toBeLessThanOrEqual(body.sampled);
  });

  it("requires admin auth", async () => {
    const res = await app.request("/v1/admin/targeting/count", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targeting: [] }),
    });
    expect(res.status).toBe(401);
  });
});
