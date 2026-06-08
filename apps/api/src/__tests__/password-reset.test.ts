import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The vitest config points DATABASE_URL at :5432; the migrated test DB lives at
// :5434. Override before importing the engine (mirrors admin-auth.test.ts).
process.env.DATABASE_URL = "postgresql://test:test@localhost:5434/test";

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

const { user } = await import("@hogsend/db");
const { eq } = await import("drizzle-orm");
const { createApp, createHogsendClient, sendResetPasswordEmail } = await import(
  "@hogsend/engine"
);

// The subset of the sendRaw options the assertions read.
interface RawArg {
  to: string;
  subject: string;
  html: string;
  text: string;
}

// --- A mailer override whose `sendRaw` is a spy. The container-wired
// `sendResetPassword` closure flows through it, so this asserts the full chain:
// better-auth → createAuth's sendResetPassword → sendResetPasswordEmail →
// emailService.sendRaw — without touching a real provider. ---
const sendRaw = vi.fn(async (_opts: RawArg) => ({ id: "test-message-id" }));
const mailerStub = {
  send: vi.fn(async () => ({
    emailSendId: "",
    messageId: "x",
    resendId: "x",
    status: "sent" as const,
  })),
  sendRaw,
  sendBatch: vi.fn(async () => ({ results: [] })),
  render: vi.fn(async () => ({
    html: "",
    text: "",
    subject: "",
    category: undefined,
  })),
  handleWebhook: vi.fn(async () => ({
    type: "email.sent" as const,
    handled: false,
  })),
};

const container = createHogsendClient({
  // biome-ignore lint/suspicious/noExplicitAny: test stub of the EmailService.
  overrides: { mailer: mailerStub as any },
});
const app = createApp(container);
const { db } = container;

const KNOWN_EMAIL = "reset-known@password-reset-test.example";
const KNOWN_ID = "password-reset-test-known";
const KNOWN_PASSWORD = "originalPassword123";

beforeAll(async () => {
  // Create a real credential user via better-auth so the credential account +
  // scrypt hash exist (request/reset operate on a real account).
  await db.delete(user).where(eq(user.email, KNOWN_EMAIL));
  await container.auth.api.signUpEmail({
    body: { email: KNOWN_EMAIL, name: "Reset Known", password: KNOWN_PASSWORD },
  });
});

afterAll(async () => {
  await db.delete(user).where(eq(user.id, KNOWN_ID));
  await db.delete(user).where(eq(user.email, KNOWN_EMAIL));
});

describe("POST /api/auth/request-password-reset", () => {
  it("known email → 200 neutral, mailer fired once with a tokened url", async () => {
    sendRaw.mockClear();
    const res = await app.request("/api/auth/request-password-reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: KNOWN_EMAIL,
        redirectTo: "http://localhost:3002/studio",
      }),
    });

    expect(res.status).toBe(200);
    expect(sendRaw).toHaveBeenCalledTimes(1);
    const arg = sendRaw.mock.calls[0]?.[0] as RawArg;
    expect(arg.to).toBe(KNOWN_EMAIL);
    // The url carries a reset token and points at the auth reset route.
    expect(arg.html).toContain("/api/auth/reset-password/");
    expect(arg.text).toContain("/api/auth/reset-password/");
  });

  it("unknown email → 200 neutral, mailer NOT fired (no enumeration)", async () => {
    sendRaw.mockClear();
    const res = await app.request("/api/auth/request-password-reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "nobody@password-reset-test.example",
        redirectTo: "http://localhost:3002/studio",
      }),
    });

    expect(res.status).toBe(200);
    expect(sendRaw).not.toHaveBeenCalled();
  });
});

describe("POST /api/auth/reset-password (end-to-end)", () => {
  it("consumes a token, sets the new password (old fails, new works), single-use", async () => {
    // 1) Request a reset and capture the token from the spied url.
    sendRaw.mockClear();
    await app.request("/api/auth/request-password-reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: KNOWN_EMAIL,
        redirectTo: "http://localhost:3002/studio",
      }),
    });
    const html = (sendRaw.mock.calls[0]?.[0] as RawArg).html;
    const match = html.match(/\/api\/auth\/reset-password\/([A-Za-z0-9]+)/);
    expect(match).toBeTruthy();
    const token = match?.[1] as string;

    const NEW_PASSWORD = "brandNewPassword456";

    // 2) Reset with the token.
    const resetRes = await app.request("/api/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newPassword: NEW_PASSWORD, token }),
    });
    expect(resetRes.status).toBe(200);

    // 3) The OLD password no longer signs in.
    const oldRes = await app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: KNOWN_EMAIL, password: KNOWN_PASSWORD }),
    });
    expect(oldRes.status).not.toBe(200);

    // 4) The NEW password signs in.
    const newRes = await app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: KNOWN_EMAIL, password: NEW_PASSWORD }),
    });
    expect(newRes.status).toBe(200);

    // 5) The token is single-use — a second reset with it fails.
    const reuseRes = await app.request("/api/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newPassword: "yetAnother789", token }),
    });
    expect(reuseRes.status).not.toBe(200);
  });
});

// --- Unit: the engine-owned reset email body + graceful no-provider path. ---

describe("sendResetPasswordEmail (engine built-in)", () => {
  const RESET_URL =
    "http://localhost:3002/api/auth/reset-password/tok123?callbackURL=%2Fstudio";

  it("renders the URL, the 15-min/single-use notice, no tracking, no footer", async () => {
    const spy = vi.fn(async (_opts: RawArg) => ({ id: "m1" }));
    await sendResetPasswordEmail({
      to: "u@example.com",
      url: RESET_URL,
      // biome-ignore lint/suspicious/noExplicitAny: minimal EmailService stub.
      emailService: { sendRaw: spy } as any,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const arg = spy.mock.calls[0]?.[0] as RawArg;
    expect(arg.to).toBe("u@example.com");
    expect(arg.html).toContain("tok123");
    expect(arg.html).toContain("15 minutes");
    expect(arg.html).toContain("can be used once");
    // No first-party tracking pixel, no unsubscribe footer (transactional).
    expect(arg.html).not.toContain("/v1/t/o/");
    expect(arg.html.toLowerCase()).not.toContain("unsubscribe");
  });

  it("swallows a provider error (resolves, no throw) and never logs the url", async () => {
    const warn = vi.fn();
    const throwingService = {
      sendRaw: vi.fn(async () => {
        throw new Error("no provider");
      }),
    };
    await expect(
      sendResetPasswordEmail({
        to: "u@example.com",
        url: RESET_URL,
        // biome-ignore lint/suspicious/noExplicitAny: minimal stub.
        emailService: throwingService as any,
        // biome-ignore lint/suspicious/noExplicitAny: minimal logger stub.
        logger: { warn } as any,
      }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    // The warning must NOT contain the url/token.
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain("tok123");
    expect(logged).not.toContain(RESET_URL);
  });
});
