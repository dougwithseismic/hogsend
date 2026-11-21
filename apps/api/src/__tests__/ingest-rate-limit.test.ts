/**
 * The browser-reachable ingest routes (everything behind
 * `requirePublishableOrIngest`) carry a sliding-window budget: per secret key,
 * and per publishable key per client IP. Proves the wiring in
 * `routes/index.ts` end to end against the real app:
 *
 *   - limited responses carry `RateLimit-*` + `X-RateLimit-*`, and CORS
 *     exposes them (plus `Retry-After`) to browser code;
 *   - past the budget the route 429s with `Retry-After`;
 *   - the order is auth → scope → rateLimit (a 401/403 spends nothing);
 *   - overlapping guards (`/feed` + `/feed/*`) count a request once;
 *   - the `/contacts` method branch keeps branching (the pk upsert is limited,
 *     the secret-only DELETE is not), and secret-only routes are untouched.
 *
 * Tiny limits come from the env the engine parses at first import. The limiter
 * no-ops under NODE_ENV=test, so this file runs its requests with NODE_ENV
 * flipped to "development" (restored in afterAll); the only request-time
 * readers of NODE_ENV are the rate limiters.
 */
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";
process.env.INGEST_RATE_LIMIT_MAX = "3";
process.env.INGEST_PUBLIC_RATE_LIMIT_MAX = "2";

const { apiKeys, contacts, userEvents } = await import("@hogsend/db");
const { inArray, like } = await import("drizzle-orm");
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
} as unknown as ReturnType<typeof createHogsendClient>["hatchet"];

const container = createHogsendClient({ overrides: { hatchet: mockHatchet } });
const app = createApp(container);
const { db } = container;

const RUN = `irl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const ORIGIN = "https://ingest-rl.example.com";
const PK = `pk_${RUN}_publishable`;
const SECRET_BUDGET = `hsk_${RUN}_budget`;
const SECRET_OTHER = `hsk_${RUN}_other`;
const ANON_IDS = [`${RUN}-anon-event`, `${RUN}-anon-contact`];

const RATE_LIMIT_HEADERS = [
  "RateLimit-Limit",
  "RateLimit-Remaining",
  "RateLimit-Reset",
  "RateLimit-Policy",
  "X-RateLimit-Limit",
  "X-RateLimit-Remaining",
  "Retry-After",
];

function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function pkHeaders(ip: string, origin = ORIGIN): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${PK}`,
    Origin: origin,
    "X-Forwarded-For": ip,
  };
}

function secretHeaders(key: string, ip = "198.51.100.1") {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${key}`,
    "X-Forwarded-For": ip,
  };
}

function exposed(res: Response): string[] {
  return (res.headers.get("access-control-expose-headers") ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

const originalNodeEnv = process.env.NODE_ENV;

beforeAll(async () => {
  await db.insert(apiKeys).values([
    {
      name: `${RUN} pk`,
      keyPrefix: PK.slice(0, 8),
      keyHash: hashKey(PK),
      scopes: ["ingest-public"],
      allowedOrigins: [ORIGIN],
    },
    {
      name: `${RUN} secret budget`,
      keyPrefix: SECRET_BUDGET.slice(0, 8),
      keyHash: hashKey(SECRET_BUDGET),
      scopes: ["ingest"],
    },
    {
      name: `${RUN} secret other`,
      keyPrefix: SECRET_OTHER.slice(0, 8),
      keyHash: hashKey(SECRET_OTHER),
      scopes: ["ingest"],
    },
  ]);
  process.env.NODE_ENV = "development";
});

afterAll(async () => {
  process.env.NODE_ENV = originalNodeEnv;
  await db.delete(userEvents).where(inArray(userEvents.userId, ANON_IDS));
  await db.delete(contacts).where(inArray(contacts.anonymousId, ANON_IDS));
  await db.delete(apiKeys).where(like(apiKeys.name, `${RUN}%`));
});

describe("ingest rate limit: headers", () => {
  it("a publishable POST /v1/events carries RateLimit-* and CORS exposes them", async () => {
    const res = await app.request("/v1/events", {
      method: "POST",
      headers: pkHeaders("203.0.113.10"),
      body: JSON.stringify({
        name: "ingest.rl.probe",
        anonymousId: ANON_IDS[0],
      }),
    });
    expect(res.status).toBe(202);
    expect(res.headers.get("RateLimit-Limit")).toBe("2");
    expect(res.headers.get("RateLimit-Remaining")).toBe("1");
    expect(res.headers.get("RateLimit-Reset")).toBe("60");
    expect(res.headers.get("RateLimit-Policy")).toBe("2;w=60");
    expect(res.headers.get("X-RateLimit-Limit")).toBe("2");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("1");

    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    const list = exposed(res);
    for (const h of RATE_LIMIT_HEADERS) {
      expect(list).toContain(h.toLowerCase());
    }
  });

  it("a secret key gets its own, larger budget on the same routes", async () => {
    const res = await app.request("/v1/lists", {
      headers: secretHeaders(SECRET_OTHER),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("RateLimit-Limit")).toBe("3");
    expect(res.headers.get("RateLimit-Policy")).toBe("3;w=60");
  });
});

describe("ingest rate limit: 429", () => {
  it("429s a publishable key past its per-IP budget, with Retry-After readable cross-origin", async () => {
    const ip = "203.0.113.20";
    for (let i = 0; i < 2; i++) {
      const ok = await app.request("/v1/lists", { headers: pkHeaders(ip) });
      expect(ok.status).toBe(200);
    }
    const over = await app.request("/v1/lists", { headers: pkHeaders(ip) });
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual({ error: "Rate limit exceeded" });
    const retryAfter = Number(over.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(over.headers.get("RateLimit-Reset")).toBe(String(retryAfter));
    expect(over.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(exposed(over)).toContain("retry-after");

    // Another visitor on the same publishable key has their own budget.
    const other = await app.request("/v1/lists", {
      headers: pkHeaders("203.0.113.21"),
    });
    expect(other.status).toBe(200);
    expect(other.headers.get("RateLimit-Remaining")).toBe("1");
  });

  it("429s a secret key past its per-key budget whatever IP it comes from", async () => {
    for (let i = 0; i < 3; i++) {
      const ok = await app.request("/v1/lists", {
        headers: secretHeaders(SECRET_BUDGET, `198.51.100.${10 + i}`),
      });
      expect(ok.status).toBe(200);
    }
    const over = await app.request("/v1/lists", {
      headers: secretHeaders(SECRET_BUDGET, "198.51.100.99"),
    });
    expect(over.status).toBe(429);
    expect(over.headers.get("Retry-After")).not.toBeNull();
  });
});

describe("ingest rate limit: ordering and branching", () => {
  it("a request that fails auth spends no budget and carries no headers", async () => {
    const ip = "203.0.113.30";
    const noKey = await app.request("/v1/lists", {
      headers: { "X-Forwarded-For": ip },
    });
    expect(noKey.status).toBe(401);
    expect(noKey.headers.get("RateLimit-Limit")).toBeNull();

    for (let i = 0; i < 3; i++) {
      const badOrigin = await app.request("/v1/lists", {
        headers: pkHeaders(ip, "https://not-allowed.example.com"),
      });
      expect(badOrigin.status).toBe(403);
      expect(badOrigin.headers.get("RateLimit-Limit")).toBeNull();
    }

    const ok = await app.request("/v1/lists", { headers: pkHeaders(ip) });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("RateLimit-Remaining")).toBe("1");
  });

  it("GET /v1/feed counts once although `/feed` and `/feed/*` both match it", async () => {
    const ip = "203.0.113.40";
    const path = `/v1/feed?anonymousId=${RUN}-feed`;
    const first = await app.request(path, { headers: pkHeaders(ip) });
    const second = await app.request(path, { headers: pkHeaders(ip) });
    expect(first.headers.get("RateLimit-Remaining")).toBe("1");
    expect(second.status).not.toBe(429);
    expect(second.headers.get("RateLimit-Remaining")).toBe("0");
  });

  it("limits the publishable /v1/contacts upsert but not the secret-only DELETE", async () => {
    const upsert = await app.request("/v1/contacts", {
      method: "PUT",
      headers: pkHeaders("203.0.113.50"),
      body: JSON.stringify({
        anonymousId: ANON_IDS[1],
        properties: { probe: true },
      }),
    });
    expect(upsert.status).toBe(200);
    expect(upsert.headers.get("RateLimit-Limit")).toBe("2");

    // DELETE stays secret-only (the method branch is intact) …
    const pkDelete = await app.request("/v1/contacts", {
      method: "DELETE",
      headers: pkHeaders("203.0.113.50"),
      body: JSON.stringify({ userId: `${RUN}-nobody` }),
    });
    expect(pkDelete.status).toBe(403);

    // … and is not rate-limited, like the other secret-only routes.
    const secretDelete = await app.request("/v1/contacts", {
      method: "DELETE",
      headers: secretHeaders(SECRET_OTHER),
      body: JSON.stringify({ userId: `${RUN}-nobody` }),
    });
    expect(secretDelete.status).not.toBe(429);
    expect(secretDelete.headers.get("RateLimit-Limit")).toBeNull();
  });

  it("leaves secret-only data-plane routes untouched", async () => {
    const res = await app.request(`/v1/contacts/find?userId=${RUN}-nobody`, {
      headers: secretHeaders(SECRET_OTHER),
    });
    expect(res.status).not.toBe(429);
    expect(res.headers.get("RateLimit-Limit")).toBeNull();
  });
});
