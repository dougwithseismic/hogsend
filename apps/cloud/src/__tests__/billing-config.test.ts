import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * WHICH billing provider a deployment gets, and what happens when it has none.
 *
 * The rule being pinned is a security one. `FakeBilling` verifies webhooks with
 * a constant committed to this (source-available) repository, and
 * `/api/billing/webhook` is public and session-exempt. A production deploy that
 * fell back to the fake would therefore be publishing an unauthenticated
 * plan-change and suspend API: anyone who knew an organization id could HMAC a
 * body with the public constant and upgrade themselves — or suspend someone
 * else's stack. So production must CHOOSE, and `fake` is not one of the choices.
 *
 * The env module reads `process.env` once at import, so each case re-imports it
 * against a stubbed environment. The negative cases are paired with a positive
 * control that differs ONLY in `CLOUD_BILLING`; without it a rejection could be
 * coming from some other missing production variable and the assertion would
 * certify nothing.
 */

/** Everything ELSE a production boot needs, so `CLOUD_BILLING` is the only
 * variable under test. */
const PRODUCTION_BASE = {
  NODE_ENV: "production",
  CLOUD_DATABASE_URL: "postgres://u:p@localhost:5434/hogsend_cloud",
  CLOUD_ENCRYPTION_SECRET: "e".repeat(48),
  CLOUD_AUTH_SECRET: "a".repeat(48),
  CLOUD_SUBSTRATE: "fake",
  // A production boot also requires an artifact bucket (PRD 14) — supplied
  // here so `CLOUD_BILLING` stays the only variable under test.
  CLOUD_ARTIFACT_BUCKET_ENDPOINT: "https://bucket.example.test",
  CLOUD_ARTIFACT_BUCKET_NAME: "artifacts",
  CLOUD_ARTIFACT_BUCKET_ACCESS_KEY_ID: "AKIA-test",
  CLOUD_ARTIFACT_BUCKET_SECRET_ACCESS_KEY: "secret-test",
} as const;

async function loadEnv(overrides: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(overrides)) {
    // `undefined` means "absent", which is exactly what a forgotten var is.
    if (value === undefined) vi.stubEnv(key, "");
    else vi.stubEnv(key, value);
  }
  return import("../env");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("CLOUD_BILLING", () => {
  it("defaults to the fake in dev/test", async () => {
    const { env } = await loadEnv({
      NODE_ENV: "test",
      CLOUD_BILLING: undefined,
    });
    expect(env.CLOUD_BILLING).toBe("fake");
  });

  it("refuses the fake provider in production", async () => {
    await expect(
      loadEnv({ ...PRODUCTION_BASE, CLOUD_BILLING: "fake" }),
    ).rejects.toThrow();
  });

  it("withholds the default in production, so a deploy must choose", async () => {
    await expect(
      loadEnv({ ...PRODUCTION_BASE, CLOUD_BILLING: undefined }),
    ).rejects.toThrow();
  });

  it("accepts stripe and disabled in production (the positive control)", async () => {
    for (const mode of ["stripe", "disabled"] as const) {
      const { env } = await loadEnv({
        ...PRODUCTION_BASE,
        CLOUD_BILLING: mode,
      });
      expect(env.CLOUD_BILLING).toBe(mode);
    }
  });
});

describe("CLOUD_BILLING=disabled", () => {
  it("has no provider to hand out", async () => {
    const { BillingDisabledError, getBilling } = await loadEnv({
      NODE_ENV: "test",
      CLOUD_BILLING: "disabled",
    }).then(() => import("../billing"));

    expect(() => getBilling()).toThrow(BillingDisabledError);
  });

  it("answers the webhook 503 — never a fake acceptance", async () => {
    await loadEnv({ NODE_ENV: "test", CLOUD_BILLING: "disabled" });
    const { POST } = await import("../../app/api/billing/webhook/route");

    const response = await POST(
      new Request("http://localhost:3004/api/billing/webhook", {
        method: "POST",
        body: JSON.stringify({ type: "checkout_completed", plan: "dedicated" }),
      }),
    );

    // 503, not 400: the payload was never the problem, and a re-delivery after
    // billing is wired should be accepted.
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "billing_disabled" });
  });
});
