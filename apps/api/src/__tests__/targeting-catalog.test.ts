import type { HogsendClient } from "@hogsend/engine";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { contacts } = await import("@hogsend/db");
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

const RUN = `catalog-${Date.now()}`;
const PROP_KEY = `${RUN}_plan`;
const EXTERNAL_ID = `${RUN}-contact`;

beforeAll(async () => {
  await db.insert(contacts).values({
    externalId: EXTERNAL_ID,
    properties: { [PROP_KEY]: "pro" },
  });
});

afterAll(async () => {
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

  it("requires admin auth", async () => {
    const res = await app.request("/v1/admin/targeting/catalog");
    expect(res.status).toBe(401);
  });
});
