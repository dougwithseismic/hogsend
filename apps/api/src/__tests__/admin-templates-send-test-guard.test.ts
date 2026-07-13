import { describe, expect, it, vi } from "vitest";

// Point at the real docker TimescaleDB (mirrors admin-templates.test.ts) — the
// deny path scans the `user` table to confirm the recipient is not an operator.
process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";
// A known operator inbox for the allow path. isOperatorAddress matches this via
// env WITHOUT a DB lookup, so the allow assertions don't depend on seeded users.
process.env.HOGSEND_TEST_EMAIL = "ops@hogsend.test";

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
const { lists } = await import("../lists/index.js");
const { createApp, createHogsendClient } = await import("@hogsend/engine");

// Stub the mailer wholesale so an allowed send returns deterministically without
// touching Resend. The recipient guard runs in the route BEFORE this, reading
// db + env (not the mailer), so the stub only exercises the post-gate path.
// biome-ignore lint/suspicious/noExplicitAny: test stub, mirrors password-reset.test.ts
const mailerStub: any = {
  send: async () => ({ status: "sent", emailSendId: "test-send-id" }),
};

const container = createHogsendClient({
  email: { templates },
  lists,
  overrides: { mailer: mailerStub },
});
const app = createApp(container);

const AUTH_HEADER = { Authorization: `Bearer ${process.env.ADMIN_API_KEY}` };

async function sendTest(to: string) {
  return app.request("/v1/admin/templates/welcome/send-test", {
    method: "POST",
    headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
    body: JSON.stringify({ to }),
  });
}

describe("POST /v1/admin/templates/{key}/send-test — operator recipient guard", () => {
  it("rejects a non-operator recipient with 403", async () => {
    const res = await sendTest("attacker@evil.com");
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/restricted/i);
  });

  it("allows a configured operator address (HOGSEND_TEST_EMAIL)", async () => {
    const res = await sendTest("ops@hogsend.test");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.emailSendId).toBe("test-send-id");
  });

  it("matches operator addresses case-insensitively", async () => {
    const res = await sendTest("OPS@HOGSEND.TEST");
    expect(res.status).toBe(200);
  });
});
