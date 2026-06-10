import { describe, expect, it } from "vitest";
import { HatchetTokenError, mintHatchetToken } from "../lib/hatchet-token.js";

/**
 * Unit tests for the headless HATCHET_CLIENT_TOKEN mint flow
 * (register-or-login → ensure tenant → create API token) against a scripted
 * fake of hatchet-lite's REST API. Covers:
 *  - happy path: fresh register → seeded "default" tenant found → token
 *  - locked-down instance: register 400 ("user signups are disabled") →
 *    login fallback with the seeded admin credentials
 *  - tenant missing from memberships → created with engineVersion V1
 *  - bad credentials → HatchetTokenError mentioning login
 *  - token is read from CreateAPITokenResponse.token verbatim
 */

interface Call {
  url: string;
  method: string;
  body?: unknown;
  cookie?: string;
}

type Route = (call: Call) => Response;

function fakeHatchet(routes: Record<string, Route>): {
  fetchImpl: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = new URL(url).pathname;
    const headers = new Headers(init?.headers);
    const call: Call = {
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      cookie: headers.get("cookie") ?? undefined,
    };
    calls.push(call);
    const route = routes[`${call.method} ${path}`];
    if (!route) {
      return new Response(JSON.stringify({ errors: [] }), { status: 404 });
    }
    return route(call);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

const loginOk = () =>
  json(
    { metadata: { id: "u1" }, email: "a@b.co" },
    { headers: { "set-cookie": "hatchet=sess-abc; Path=/; HttpOnly" } },
  );

const membershipsWith = (slug: string, id: string) =>
  json({ rows: [{ tenant: { metadata: { id }, slug } }] });

describe("mintHatchetToken", () => {
  it("registers, finds the seeded default tenant, and mints the token", async () => {
    const { fetchImpl, calls } = fakeHatchet({
      "POST /api/v1/users/register": () => json({ metadata: { id: "u1" } }),
      "POST /api/v1/users/login": loginOk,
      "GET /api/v1/users/memberships": () =>
        membershipsWith("default", "tenant-1"),
      "POST /api/v1/tenants/tenant-1/api-tokens": () =>
        json({ token: "jwt-token-123" }),
    });

    const result = await mintHatchetToken({
      url: "https://hatchet.example.com/",
      email: "admin@acme.com",
      password: "Sup3rSecret!!",
      fetchImpl,
    });

    expect(result).toEqual({
      token: "jwt-token-123",
      tenantId: "tenant-1",
      tenantSlug: "default",
      createdTenant: false,
      registered: true,
    });
    // Authed calls carry the session cookie from login.
    const tokenCall = calls.find((c) => c.url.includes("api-tokens"));
    expect(tokenCall?.cookie).toBe("hatchet=sess-abc");
    expect(tokenCall?.body).toEqual({ name: "hogsend" });
  });

  it("falls back to login when signups are disabled (SERVER_ALLOW_SIGNUP=false)", async () => {
    const { fetchImpl } = fakeHatchet({
      "POST /api/v1/users/register": () =>
        json(
          { errors: [{ description: "user signups are disabled" }] },
          { status: 400 },
        ),
      "POST /api/v1/users/login": loginOk,
      "GET /api/v1/users/memberships": () =>
        membershipsWith("default", "tenant-1"),
      "POST /api/v1/tenants/tenant-1/api-tokens": () =>
        json({ token: "jwt-token-456" }),
    });

    const result = await mintHatchetToken({
      url: "https://hatchet.example.com",
      email: "admin@acme.com",
      password: "Sup3rSecret!!",
      fetchImpl,
    });

    expect(result.token).toBe("jwt-token-456");
    expect(result.registered).toBe(false);
  });

  it("creates the tenant (engineVersion V1) when the slug has no membership", async () => {
    const { fetchImpl, calls } = fakeHatchet({
      "POST /api/v1/users/register": () =>
        json({ errors: [] }, { status: 400 }),
      "POST /api/v1/users/login": loginOk,
      "GET /api/v1/users/memberships": () => json({ rows: [] }),
      "POST /api/v1/tenants": () =>
        json({ metadata: { id: "tenant-9" }, slug: "hogsend" }),
      "POST /api/v1/tenants/tenant-9/api-tokens": () =>
        json({ token: "jwt-token-789" }),
    });

    const result = await mintHatchetToken({
      url: "https://hatchet.example.com",
      email: "admin@acme.com",
      password: "Sup3rSecret!!",
      tenantSlug: "hogsend",
      tokenName: "worker",
      fetchImpl,
    });

    expect(result).toMatchObject({
      token: "jwt-token-789",
      tenantId: "tenant-9",
      tenantSlug: "hogsend",
      createdTenant: true,
    });
    const createCall = calls.find((c) => c.url.endsWith("/api/v1/tenants"));
    expect(createCall?.body).toEqual({
      name: "hogsend",
      slug: "hogsend",
      engineVersion: "V1",
    });
    expect(createCall?.cookie).toBe("hatchet=sess-abc");
    const tokenCall = calls.find((c) => c.url.includes("api-tokens"));
    expect(tokenCall?.body).toEqual({ name: "worker" });
  });

  it("throws a login error (with Hatchet's description) on bad credentials", async () => {
    const { fetchImpl } = fakeHatchet({
      "POST /api/v1/users/register": () =>
        json({ errors: [] }, { status: 400 }),
      "POST /api/v1/users/login": () =>
        json(
          { errors: [{ description: "invalid email or password" }] },
          { status: 401 },
        ),
    });

    await expect(
      mintHatchetToken({
        url: "https://hatchet.example.com",
        email: "admin@acme.com",
        password: "wrong",
        fetchImpl,
      }),
    ).rejects.toThrowError(/login failed \(401\): invalid email or password/);
  });

  it("rejects an invalid base url and an invalid tenant slug without fetching", async () => {
    const { fetchImpl, calls } = fakeHatchet({});

    await expect(
      mintHatchetToken({
        url: "hatchet.example.com",
        email: "a@b.co",
        password: "x",
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(HatchetTokenError);

    await expect(
      mintHatchetToken({
        url: "https://hatchet.example.com",
        email: "a@b.co",
        password: "x",
        tenantSlug: "Not A Slug",
        fetchImpl,
      }),
    ).rejects.toThrowError(/invalid tenant slug/);

    expect(calls).toHaveLength(0);
  });
});
