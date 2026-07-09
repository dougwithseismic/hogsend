import { beforeAll, describe, expect, it, vi } from "vitest";

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

const { templates } = await import("../emails/index.js");
// The real app lists (incl. `product-updates`) — wired so the marketing
// template's `product-updates` category resolves to a defined list, matching
// `src/index.ts`. The container boot-guard rejects a template category that is
// neither a reserved built-in nor a defined list.
const { lists } = await import("../lists/index.js");
const { createApp, createHogsendClient } = await import("@hogsend/engine");

const container = createHogsendClient({ email: { templates }, lists });
const app = createApp(container);

const AUTH_HEADER = { Authorization: `Bearer ${process.env.ADMIN_API_KEY}` };

beforeAll(() => {
  // Sanity: the dogfood registry should be wired in for these tests.
  expect(Object.keys(templates).length).toBeGreaterThan(0);
});

describe("GET /v1/admin/templates", () => {
  it("returns 401 without auth", async () => {
    const res = await app.request("/v1/admin/templates");
    expect(res.status).toBe(401);
  });

  it("returns the template catalog", async () => {
    const res = await app.request("/v1/admin/templates", {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.templates).toBeInstanceOf(Array);
    expect(body.templates.length).toBe(Object.keys(templates).length);

    const welcome = body.templates.find(
      (t: { key: string }) => t.key === "welcome",
    );
    expect(welcome).toBeDefined();
    expect(welcome.defaultSubject).toBe("Welcome to Hogsend");
    expect(welcome.category).toBe("transactional");
    expect(welcome.hasPreview).toBe(true);
  });
});

describe("GET /v1/admin/templates/{key}/preview", () => {
  it("returns 401 without auth", async () => {
    const res = await app.request("/v1/admin/templates/welcome/preview");
    expect(res.status).toBe(401);
  });

  it("returns 404 for an unknown template", async () => {
    const res = await app.request(
      "/v1/admin/templates/no-such-template-xyz/preview",
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(404);
  });

  it("renders html + text for a known template", async () => {
    const res = await app.request("/v1/admin/templates/welcome/preview", {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.key).toBe("welcome");
    expect(body.subject).toBe("Welcome to Hogsend");
    expect(body.category).toBe("transactional");
    expect(typeof body.html).toBe("string");
    expect(typeof body.text).toBe("string");
    // The welcome template greets by `name`; examples set it to "Ada".
    expect(body.html).toContain("Ada");
    expect(body.html).toContain("Lifecycle email, as code.");
  });

  it("merges caller-supplied base64 props over examples", async () => {
    const props = Buffer.from(JSON.stringify({ name: "Grace" })).toString(
      "base64",
    );
    const res = await app.request(
      `/v1/admin/templates/welcome/preview?props=${encodeURIComponent(props)}`,
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.html).toContain("Grace");
  });

  it("returns raw html for ?format=html", async () => {
    const res = await app.request(
      "/v1/admin/templates/welcome/preview?format=html",
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");

    const text = await res.text();
    expect(text).toContain("Lifecycle email, as code.");
  });

  it("returns raw text for ?format=text", async () => {
    const res = await app.request(
      "/v1/admin/templates/welcome/preview?format=text",
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
  });

  it("returns 400 for malformed props", async () => {
    const res = await app.request(
      "/v1/admin/templates/welcome/preview?props=%25%25notbase64json%25%25",
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /v1/admin/templates/{key}/send-test", () => {
  it("returns 401 without auth", async () => {
    const res = await app.request("/v1/admin/templates/welcome/send-test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: "test@example.com" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 404 for an unknown template", async () => {
    const res = await app.request(
      "/v1/admin/templates/no-such-template-xyz/send-test",
      {
        method: "POST",
        headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
        body: JSON.stringify({ to: "test@example.com" }),
      },
    );
    expect(res.status).toBe(404);
  });

  it("validates the recipient email", async () => {
    const res = await app.request("/v1/admin/templates/welcome/send-test", {
      method: "POST",
      headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
      body: JSON.stringify({ to: "not-an-email" }),
    });
    // Zod request validation rejects a bad address before any send happens.
    expect(res.status).toBe(400);
  });
});
