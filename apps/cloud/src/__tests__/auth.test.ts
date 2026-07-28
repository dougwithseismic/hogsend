import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sqlClient } from "../db";
import { runCloudMigrations } from "../db/migrator";
import { user } from "../db/schema/auth";
import { env } from "../env";
import { CLOUD_SESSION_COOKIE_NAME, createCloudAuth } from "../lib/auth";
import { guardRoute, sanitizeNext } from "../lib/auth-guard";
import type { EmailMessage, EmailSender } from "../lib/email-sender";

/**
 * Against the REAL database and the REAL Better Auth instance — a mocked
 * adapter would prove nothing about the drizzle mapping onto the `cloud` schema
 * (the thing most likely to be wrong) or about the cookie the browser receives.
 *
 * The only injected part is the email transport: a spy, so the OTP is captured
 * in-process and NO test can reach a mail provider.
 */

const EMAILS = [
  "auth-test-signup@hogsend.test",
  "auth-test-wrongpass@hogsend.test",
];

const sent: EmailMessage[] = [];
const spySender: EmailSender = {
  id: "spy",
  async send(message) {
    sent.push(message);
  },
};

const auth = createCloudAuth({ emailSender: spySender });

async function cleanup(): Promise<void> {
  // account/session cascade off user.
  await db.delete(user).where(inArray(user.email, EMAILS));
}

beforeAll(async () => {
  await runCloudMigrations(env.CLOUD_DATABASE_URL);
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await sqlClient.end();
});

describe("cloud auth", () => {
  it("creates a user on public sign-up and mails an OTP", async () => {
    const email = EMAILS[0] as string;
    const result = await auth.api.signUpEmail({
      body: { name: "Auth Test", email, password: "correct-horse-8" },
    });

    expect(result.user.email).toBe(email);

    const rows = await db
      .select()
      .from(user)
      .where(inArray(user.email, [email]));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.emailVerified).toBe(false);

    // sendVerificationOnSignUp: the code is delivered without a second click.
    const otpMail = sent.find((m) => m.to === email);
    expect(otpMail).toBeDefined();
    expect(otpMail?.text).toMatch(/\b\d{6}\b/);
  });

  it("rejects a wrong password and accepts the right one", async () => {
    const email = EMAILS[1] as string;
    await auth.api.signUpEmail({
      body: { name: "Auth Test 2", email, password: "correct-horse-8" },
    });

    const rejected = await auth.api.signInEmail({
      body: { email, password: "wrong-horse-8" },
      asResponse: true,
    });
    expect(rejected.status).toBe(401);
    expect(rejected.headers.get("set-cookie")).toBeNull();

    const ok = await auth.api.signInEmail({
      body: { email, password: "correct-horse-8" },
      asResponse: true,
    });
    expect(ok.status).toBe(200);
  });

  it("issues the session cookie under the hscloud prefix, never hogsend", async () => {
    const email = EMAILS[1] as string;
    const res = await auth.api.signInEmail({
      body: { email, password: "correct-horse-8" },
      asResponse: true,
    });

    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(CLOUD_SESSION_COOKIE_NAME);
    expect(CLOUD_SESSION_COOKIE_NAME).toBe("hscloud.session_token");
    // The engine owns `hogsend.*` on the same apex domain; a collision here is
    // the login-loop bug this prefix exists to prevent.
    expect(setCookie).not.toContain("hogsend.session_token");
  });

  it("verifies the emailed OTP", async () => {
    const email = EMAILS[0] as string;
    const otp = sent
      .find((m) => m.to === email)
      ?.text.match(/\b(\d{6})\b/)?.[1];
    expect(otp).toBeDefined();

    await auth.api.verifyEmailOTP({ body: { email, otp: otp as string } });

    const rows = await db
      .select()
      .from(user)
      .where(inArray(user.email, [email]));
    expect(rows[0]?.emailVerified).toBe(true);
  });
});

describe("route guard", () => {
  const protectedPaths = ["/", "/environments", "/usage", "/settings"];

  it.each(protectedPaths)("redirects %s to /login when signed out", (path) => {
    expect(guardRoute({ pathname: path, hasSession: false })).toEqual({
      action: "redirect",
      to: "/login",
    });
  });

  it.each(protectedPaths)("allows %s when signed in", (path) => {
    expect(guardRoute({ pathname: path, hasSession: true })).toEqual({
      action: "allow",
    });
  });

  it("guards nested dashboard routes too", () => {
    expect(
      guardRoute({ pathname: "/environments/env_123", hasSession: false }),
    ).toEqual({ action: "redirect", to: "/login" });
  });

  it("lets a signed-out visitor reach the auth screens", () => {
    for (const path of ["/login", "/signup"]) {
      expect(guardRoute({ pathname: path, hasSession: false })).toEqual({
        action: "allow",
      });
    }
  });

  it("bounces a signed-in visitor off the auth screens", () => {
    for (const path of ["/login", "/signup"]) {
      expect(guardRoute({ pathname: path, hasSession: true })).toEqual({
        action: "redirect",
        to: "/",
      });
    }
  });

  it("lets anyone read the public legal pages", () => {
    // Linked from the sign-in screen, so a redirect here would be a dead link
    // for exactly the visitor most likely to follow it. (Fuller coverage lives
    // in legal.test.ts.)
    for (const hasSession of [false, true]) {
      expect(guardRoute({ pathname: "/terms", hasSession })).toEqual({
        action: "allow",
      });
    }
  });

  it("leaves unlisted paths alone rather than looping them", () => {
    expect(guardRoute({ pathname: "/api-docs", hasSession: false })).toEqual({
      action: "allow",
    });
  });
});

describe("sanitizeNext", () => {
  it("keeps a same-origin path", () => {
    expect(sanitizeNext("/accept-invitation/abc")).toBe(
      "/accept-invitation/abc",
    );
  });

  it("refuses anything that could leave this origin", () => {
    // An invitation link is mail-delivered and tampered with; a post-sign-in
    // redirect to another origin would be an open redirect.
    for (const value of [
      "//evil.example",
      "/\\evil.example",
      "https://evil.example",
      "javascript:alert(1)",
      "",
      null,
      undefined,
    ]) {
      expect(sanitizeNext(value)).toBe("/");
    }
  });
});
