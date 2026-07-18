import { createHash } from "node:crypto";
import type { HogsendClient } from "@hogsend/engine";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { apiKeys, contacts, flags } = await import("@hogsend/db");
const { eq, inArray } = await import("drizzle-orm");
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

const RUN = `flg-${Date.now()}`;
const ORIGIN = "https://app.example.com";
const PK_KEY = `pk_${RUN}_publishable`;
const SECRET_KEY = `sk_${RUN}_ingest`;
const IDENTIFIED_USER = `${RUN}-identified`;
const ANON_ID = `${RUN}-anon`;

const AUTH_ADMIN = { Authorization: `Bearer ${process.env.ADMIN_API_KEY}` };

function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

const flagKeys = [`${RUN}-onboarding`, `${RUN}-pro-only`];
let pkId = "";
let secretId = "";
let identifiedContactId = "";

beforeAll(async () => {
  const [pk] = await db
    .insert(apiKeys)
    .values({
      name: "flags pub",
      keyPrefix: PK_KEY.slice(0, 8),
      keyHash: hashKey(PK_KEY),
      scopes: ["ingest-public"],
      allowedOrigins: [ORIGIN],
    })
    .returning({ id: apiKeys.id });
  pkId = pk?.id ?? "";

  const [sk] = await db
    .insert(apiKeys)
    .values({
      name: "flags secret",
      keyPrefix: SECRET_KEY.slice(0, 8),
      keyHash: hashKey(SECRET_KEY),
      scopes: ["ingest"],
    })
    .returning({ id: apiKeys.id });
  secretId = sk?.id ?? "";

  // An IDENTIFIED contact whose externalId a pk_ caller must not impersonate.
  const [victim] = await db
    .insert(contacts)
    .values({
      externalId: IDENTIFIED_USER,
      properties: { plan: "pro" },
    })
    .returning({ id: contacts.id });
  identifiedContactId = victim?.id ?? "";
});

afterAll(async () => {
  await db.delete(flags).where(inArray(flags.key, flagKeys));
  await db.delete(contacts).where(eq(contacts.externalId, IDENTIFIED_USER));
  if (pkId) await db.delete(apiKeys).where(eq(apiKeys.id, pkId));
  if (secretId) await db.delete(apiKeys).where(eq(apiKeys.id, secretId));
});

function adminPost(path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_ADMIN },
    body: JSON.stringify(body),
  });
}

describe("flags admin CRUD + browser/server evaluation", () => {
  let onboardingId = "";

  it("creates a flag via POST /v1/admin/flags", async () => {
    const res = await adminPost("/v1/admin/flags", {
      key: `${RUN}-onboarding`,
      name: "New onboarding",
      type: "boolean",
      rollout: 100,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { flag: { id: string; key: string } };
    expect(body.flag.key).toBe(`${RUN}-onboarding`);
    onboardingId = body.flag.id;

    // A targeted flag: only plan=pro contacts get it.
    const res2 = await adminPost("/v1/admin/flags", {
      key: `${RUN}-pro-only`,
      name: "Pro only",
      type: "boolean",
      rollout: 100,
      targeting: [
        { type: "property", property: "plan", operator: "eq", value: "pro" },
      ],
    });
    expect(res2.status).toBe(201);
  });

  it("rejects a duplicate live key with 409", async () => {
    const res = await adminPost("/v1/admin/flags", {
      key: `${RUN}-onboarding`,
      name: "dupe",
      type: "boolean",
    });
    expect(res.status).toBe(409);
  });

  it("GET /v1/flags as a pk_/anon caller returns the evaluated map", async () => {
    const res = await app.request(`/v1/flags?anonymousId=${ANON_ID}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${PK_KEY}`, Origin: ORIGIN },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { flags: Record<string, unknown> };
    // Ungated flag is present; the anon contact has no `plan` so the targeted
    // flag falls to its default (false).
    expect(body.flags[`${RUN}-onboarding`]).toBe(true);
    expect(body.flags[`${RUN}-pro-only`]).toBe(false);
  });

  it("a pk_ anonymousId colliding with an IDENTIFIED contact → 403", async () => {
    const res = await app.request(
      `/v1/flags?anonymousId=${encodeURIComponent(IDENTIFIED_USER)}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${PK_KEY}`, Origin: ORIGIN },
      },
    );
    expect(res.status).toBe(403);
  });

  it("a pk_ anonymousId = a victim's internal contact UUID does not leak their targeting", async () => {
    // The uuid is not a collision on external_id/email/anonymous_id, so the
    // request is NOT 403 — but it must resolve to the caller's OWN (empty)
    // contact, never load the victim's plan=pro properties.
    const res = await app.request(
      `/v1/flags?anonymousId=${encodeURIComponent(identifiedContactId)}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${PK_KEY}`, Origin: ORIGIN },
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { flags: Record<string, unknown> };
    // The pro-only flag must NOT leak the victim's membership.
    expect(body.flags[`${RUN}-pro-only`]).toBe(false);
  });

  it("GET /v1/flags with no identity → 400", async () => {
    const res = await app.request("/v1/flags", {
      method: "GET",
      headers: { Authorization: `Bearer ${PK_KEY}`, Origin: ORIGIN },
    });
    expect(res.status).toBe(400);
  });

  it("POST /v1/flags/evaluate (secret + userId) returns the map with targeting applied", async () => {
    const res = await app.request("/v1/flags/evaluate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SECRET_KEY}`,
      },
      body: JSON.stringify({ userId: IDENTIFIED_USER }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { flags: Record<string, unknown> };
    // This contact IS plan=pro → the targeted flag evaluates true.
    expect(body.flags[`${RUN}-onboarding`]).toBe(true);
    expect(body.flags[`${RUN}-pro-only`]).toBe(true);
  });

  it("POST /v1/flags/evaluate rejects a publishable key (secret-only) → 403", async () => {
    const res = await app.request("/v1/flags/evaluate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${PK_KEY}`,
        Origin: ORIGIN,
      },
      body: JSON.stringify({ userId: IDENTIFIED_USER }),
    });
    expect(res.status).toBe(403);
  });

  it("toggles enabled off via PATCH → the flag serves its default", async () => {
    const patch = await app.request(`/v1/admin/flags/${onboardingId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...AUTH_ADMIN },
      body: JSON.stringify({ enabled: false }),
    });
    expect(patch.status).toBe(200);

    const res = await app.request(`/v1/flags?anonymousId=${ANON_ID}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${PK_KEY}`, Origin: ORIGIN },
    });
    const body = (await res.json()) as { flags: Record<string, unknown> };
    // Disabled → the key is no longer served among the LIVE-enabled set.
    expect(body.flags[`${RUN}-onboarding`]).toBeUndefined();
  });

  it("archives a flag via DELETE and frees the key for reuse", async () => {
    // Re-enable, then archive.
    await app.request(`/v1/admin/flags/${onboardingId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...AUTH_ADMIN },
      body: JSON.stringify({ enabled: true }),
    });
    const del = await app.request(`/v1/admin/flags/${onboardingId}`, {
      method: "DELETE",
      headers: AUTH_ADMIN,
    });
    expect(del.status).toBe(200);

    // The key is free again — a create with the same key now succeeds.
    const recreate = await adminPost("/v1/admin/flags", {
      key: `${RUN}-onboarding`,
      name: "onboarding v2",
      type: "boolean",
    });
    expect(recreate.status).toBe(201);
  });
});
