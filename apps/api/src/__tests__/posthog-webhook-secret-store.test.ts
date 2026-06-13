import type { HogsendClient } from "@hogsend/engine";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// DB-touching test: point at the real docker TimescaleDB, overriding the
// vitest.config placeholder DATABASE_URL (mirrors the other admin-route tests).
process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// POSTHOG_WEBHOOK_SECRET MUST be unset so the inbound source resolves the
// minted secret from the kind="derived" store at request time — the runtime
// half of `hogsend connect posthog`.
delete process.env.POSTHOG_WEBHOOK_SECRET;

const { providerCredentials } = await import("@hogsend/db");
const { contacts, userEvents } = await import("@hogsend/db");
const { eq } = await import("drizzle-orm");
const { createApp, createHogsendClient, saveDerivedCredential } = await import(
  "@hogsend/engine"
);
const { webhookSources } = await import("../webhook-sources/index.js");

// Hatchet injected via the container override seam so the ingest pipeline's
// `hatchet.events.push` never dials a real gRPC server.
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
const app = createApp(container, { webhookSources });
const { db } = container;

const MINTED = "minted_secret_for_inbound_test";

// A minimal, schema-valid PostHog webhook payload (the posthog source's Zod
// schema requires event.event + event.distinct_id).
const validPayload = (distinctId: string) => ({
  event: { event: "user.signed_up", distinct_id: distinctId },
  person: { properties: { email: `${distinctId}@example.com` } },
});

async function postPosthog(
  body: unknown,
  headers: Record<string, string> = {},
) {
  return app.request("/v1/webhooks/posthog", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function cleanupDistinct(distinctId: string) {
  await db.delete(userEvents).where(eq(userEvents.userId, distinctId));
  await db.delete(contacts).where(eq(contacts.externalId, distinctId));
}

// Store the minted secret for the whole file. The source caches the resolved
// secret per-process for ~30s, so keeping ONE stable value file-wide avoids the
// cache fighting per-test mutations (the cache is intentional production
// behavior — see resolveStoredPosthogSecret).
beforeAll(async () => {
  await db
    .delete(providerCredentials)
    .where(eq(providerCredentials.providerId, "posthog"));
  await saveDerivedCredential(db, "posthog", { webhookSecret: MINTED });
});

afterAll(async () => {
  await db
    .delete(providerCredentials)
    .where(eq(providerCredentials.providerId, "posthog"));
});

describe("inbound posthog webhook — stored derived secret resolution", () => {
  it("verifies against the stored minted secret when env has none", async () => {
    const distinctId = `pw-ok-${Date.now()}`;
    try {
      const res = await postPosthog(validPayload(distinctId), {
        "x-posthog-webhook-secret": MINTED,
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { ok: boolean; userId?: string };
      expect(json.ok).toBe(true);
      expect(json.userId).toBe(distinctId);
    } finally {
      await cleanupDistinct(distinctId);
    }
  });

  it("rejects a wrong secret with 401 once a derived secret is stored", async () => {
    const res = await postPosthog(validPayload("pw-bad"), {
      "x-posthog-webhook-secret": "not-the-secret",
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("Invalid webhook secret");
  });
});
