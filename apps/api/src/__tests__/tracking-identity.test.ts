import type { HogsendClient } from "@hogsend/engine";
import { afterAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";
// MUST be set before the engine env singleton is imported — this file gets
// its own module graph, so the flag is scoped to these tests.
process.env.TRACKING_IDENTITY_TOKEN = "true";

const { contacts, emailSends, trackedLinks, userEvents } = await import(
  "@hogsend/db"
);
const { inArray } = await import("drizzle-orm");
const {
  createApp,
  createHogsendClient,
  generateIdentityToken,
  InvalidIdentityTokenError,
  validateIdentityToken,
} = await import("@hogsend/engine");

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
const { db, env } = container;

const SECRET = env.BETTER_AUTH_SECRET;
const RUN = `idt-${Date.now()}`;

const sendIds: string[] = [];
const userKeys: string[] = [];

afterAll(async () => {
  if (userKeys.length > 0) {
    await db.delete(userEvents).where(inArray(userEvents.userId, userKeys));
    await db.delete(contacts).where(inArray(contacts.email, userKeys));
  }
  if (sendIds.length > 0) {
    await db.delete(emailSends).where(inArray(emailSends.id, sendIds));
  }
});

describe("identity token", () => {
  it("round-trips and is OPAQUE (no readable identity in the URL param)", () => {
    const token = generateIdentityToken({
      secret: SECRET,
      distinctId: "person@example.com",
      emailSendId: "send-1",
    });

    // Encrypted, not merely signed: an email-address distinct id must never
    // be recoverable from the token without the secret.
    expect(Buffer.from(token, "base64url").toString("utf-8")).not.toContain(
      "person@example.com",
    );

    const payload = validateIdentityToken({ token, secret: SECRET });
    expect(payload.distinctId).toBe("person@example.com");
    expect(payload.emailSendId).toBe("send-1");
  });

  it("rejects an expired token", () => {
    const token = generateIdentityToken({
      secret: SECRET,
      distinctId: "u-1",
      emailSendId: "send-1",
      expiresInSeconds: -10,
    });
    expect(() => validateIdentityToken({ token, secret: SECRET })).toThrow(
      InvalidIdentityTokenError,
    );
  });

  it("rejects tampering and wrong secrets", () => {
    const token = generateIdentityToken({
      secret: SECRET,
      distinctId: "u-1",
      emailSendId: "send-1",
    });
    const tampered = `${token.slice(0, -2)}AA`;
    expect(() =>
      validateIdentityToken({ token: tampered, secret: SECRET }),
    ).toThrow(InvalidIdentityTokenError);
    expect(() =>
      validateIdentityToken({ token, secret: "another-secret-entirely-...." }),
    ).toThrow(InvalidIdentityTokenError);
  });
});

describe("POST /v1/t/identify", () => {
  it("exchanges a valid token for the distinct id", async () => {
    const token = generateIdentityToken({
      secret: SECRET,
      distinctId: "user-42",
      emailSendId: "send-42",
    });
    const res = await app.request("/v1/t/identify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      distinctId: "user-42",
      emailSendId: "send-42",
    });
  });

  it("400s garbage", async () => {
    const res = await app.request("/v1/t/identify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "not-a-token" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /v1/t/c/:id — hs_t on redirect (TRACKING_IDENTITY_TOKEN)", () => {
  it("appends a resolvable token to the destination", async () => {
    const sendRows = await db
      .insert(emailSends)
      .values({
        fromEmail: "test@hogsend.com",
        toEmail: `${RUN}-redir@example.com`,
        subject: "Identity test",
        status: "sent",
        sentAt: new Date(),
      })
      .returning({ id: emailSends.id, toEmail: emailSends.toEmail });
    const send = sendRows[0];
    if (!send) throw new Error("fixture insert failed");
    sendIds.push(send.id);
    userKeys.push(send.toEmail);

    const linkRows = await db
      .insert(trackedLinks)
      .values({
        emailSendId: send.id,
        originalUrl: "https://example.com/docs?utm_source=email",
      })
      .returning({ id: trackedLinks.id });

    const res = await app.request(`/v1/t/c/${linkRows[0]?.id}`, {
      redirect: "manual",
    });
    expect(res.status).toBe(302);

    const location = new URL(res.headers.get("location") ?? "");
    // Existing params survive; the token is appended.
    expect(location.searchParams.get("utm_source")).toBe("email");
    const token = location.searchParams.get("hs_t");
    expect(token).toBeTruthy();

    const payload = validateIdentityToken({
      token: token ?? "",
      secret: SECRET,
    });
    expect(payload.distinctId).toBe(send.toEmail);
    expect(payload.emailSendId).toBe(send.id);
  });
});
