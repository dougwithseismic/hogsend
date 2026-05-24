import { describe, expect, it } from "vitest";
import {
  generateUnsubscribeToken,
  InvalidTokenError,
  validateUnsubscribeToken,
} from "../unsubscribe-tokens.js";
import {
  generatePreferenceCenterUrl,
  generateUnsubscribeUrl,
} from "../unsubscribe-url.js";

const SECRET = "test-secret-minimum-32-characters-long-ok";

describe("unsubscribe tokens", () => {
  it("round-trips a global unsubscribe token", () => {
    const token = generateUnsubscribeToken({
      secret: SECRET,
      externalId: "user-123",
      email: "user@example.com",
      action: "unsubscribe",
    });

    const payload = validateUnsubscribeToken(token, SECRET);
    expect(payload.externalId).toBe("user-123");
    expect(payload.email).toBe("user@example.com");
    expect(payload.action).toBe("unsubscribe");
    expect(payload.category).toBeUndefined();
    expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("round-trips a category unsubscribe token", () => {
    const token = generateUnsubscribeToken({
      secret: SECRET,
      externalId: "user-456",
      email: "user@example.com",
      category: "journey",
      action: "unsubscribe",
    });

    const payload = validateUnsubscribeToken(token, SECRET);
    expect(payload.category).toBe("journey");
    expect(payload.action).toBe("unsubscribe");
  });

  it("round-trips a resubscribe token", () => {
    const token = generateUnsubscribeToken({
      secret: SECRET,
      externalId: "user-789",
      email: "user@example.com",
      category: "journey",
      action: "resubscribe",
    });

    const payload = validateUnsubscribeToken(token, SECRET);
    expect(payload.action).toBe("resubscribe");
    expect(payload.category).toBe("journey");
  });

  it("round-trips a manage token", () => {
    const token = generateUnsubscribeToken({
      secret: SECRET,
      externalId: "user-abc",
      email: "user@example.com",
      action: "manage",
    });

    const payload = validateUnsubscribeToken(token, SECRET);
    expect(payload.action).toBe("manage");
  });

  it("rejects an expired token", () => {
    const token = generateUnsubscribeToken({
      secret: SECRET,
      externalId: "user-123",
      email: "user@example.com",
      action: "unsubscribe",
      expiresInSeconds: -1,
    });

    expect(() => validateUnsubscribeToken(token, SECRET)).toThrow(
      InvalidTokenError,
    );
    expect(() => validateUnsubscribeToken(token, SECRET)).toThrow(
      "Token has expired",
    );
  });

  it("rejects a tampered payload", () => {
    const token = generateUnsubscribeToken({
      secret: SECRET,
      externalId: "user-123",
      email: "user@example.com",
      action: "unsubscribe",
    });

    const [, signature] = token.split(".");
    const tamperedPayload = Buffer.from(
      JSON.stringify({
        externalId: "hacker",
        email: "hacker@evil.com",
        action: "unsubscribe",
        exp: Math.floor(Date.now() / 1000) + 99999,
      }),
    ).toString("base64url");

    expect(() =>
      validateUnsubscribeToken(`${tamperedPayload}.${signature}`, SECRET),
    ).toThrow(InvalidTokenError);
  });

  it("rejects a tampered signature", () => {
    const token = generateUnsubscribeToken({
      secret: SECRET,
      externalId: "user-123",
      email: "user@example.com",
      action: "unsubscribe",
    });

    const [payload] = token.split(".");
    const badSig = Buffer.from("not-a-valid-signature").toString("base64url");

    expect(() =>
      validateUnsubscribeToken(`${payload}.${badSig}`, SECRET),
    ).toThrow(InvalidTokenError);
  });

  it("rejects a wrong secret", () => {
    const token = generateUnsubscribeToken({
      secret: SECRET,
      externalId: "user-123",
      email: "user@example.com",
      action: "unsubscribe",
    });

    expect(() =>
      validateUnsubscribeToken(token, "wrong-secret-also-32-characters-long"),
    ).toThrow(InvalidTokenError);
  });

  it("rejects a malformed token without a dot", () => {
    expect(() => validateUnsubscribeToken("nodot", SECRET)).toThrow(
      InvalidTokenError,
    );
    expect(() => validateUnsubscribeToken("nodot", SECRET)).toThrow(
      "Malformed token",
    );
  });

  it("uses 30-day default expiry", () => {
    const token = generateUnsubscribeToken({
      secret: SECRET,
      externalId: "user-123",
      email: "user@example.com",
      action: "unsubscribe",
    });

    const payload = validateUnsubscribeToken(token, SECRET);
    const expectedExp = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
    expect(Math.abs(payload.exp - expectedExp)).toBeLessThan(5);
  });
});

describe("unsubscribe URLs", () => {
  const baseUrl = "https://api.hogsend.com";

  it("generates a global unsubscribe URL", () => {
    const url = generateUnsubscribeUrl({
      baseUrl,
      secret: SECRET,
      externalId: "user-123",
      email: "user@example.com",
    });

    expect(url).toMatch(
      /^https:\/\/api\.hogsend\.com\/v1\/email\/unsubscribe\?token=.+/,
    );

    const parsed = new URL(url);
    const token = parsed.searchParams.get("token") as string;
    const payload = validateUnsubscribeToken(token, SECRET);
    expect(payload.action).toBe("unsubscribe");
    expect(payload.externalId).toBe("user-123");
  });

  it("generates a category unsubscribe URL", () => {
    const url = generateUnsubscribeUrl({
      baseUrl,
      secret: SECRET,
      externalId: "user-123",
      email: "user@example.com",
      category: "journey",
    });

    const parsed = new URL(url);
    const token = parsed.searchParams.get("token") as string;
    const payload = validateUnsubscribeToken(token, SECRET);
    expect(payload.category).toBe("journey");
  });

  it("generates a preference center URL", () => {
    const url = generatePreferenceCenterUrl({
      baseUrl,
      secret: SECRET,
      externalId: "user-123",
      email: "user@example.com",
    });

    expect(url).toMatch(
      /^https:\/\/api\.hogsend\.com\/v1\/email\/preferences\?token=.+/,
    );

    const parsed = new URL(url);
    const token = parsed.searchParams.get("token") as string;
    const payload = validateUnsubscribeToken(token, SECRET);
    expect(payload.action).toBe("manage");
  });
});
