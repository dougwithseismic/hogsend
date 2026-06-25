import type { AnalyticsProvider, HogsendClient } from "@hogsend/engine";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// Hatchet via the override seam — direct `ingestEvent` calls push onto a spy
// instead of a live engine, and the singleton-path POST /v1/events case lands
// its downstream push here too.
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

const { userEvents } = await import("@hogsend/db");
const { inArray } = await import("drizzle-orm");
const { createApp, createHogsendClient, ingestEvent } = await import(
  "@hogsend/engine"
);

// ---------------------------------------------------------------------------
// Spy analytics provider whose `capture` is a `vi.fn()`. The event mirror fires
// `mirrorProvider.capture({ distinctId, event, properties })` gated by
// enabled + personWrites + source!=="posthog" + allow/deny. `personWrites: true`
// is required for the mirror to fire at all.
// ---------------------------------------------------------------------------
const capture = vi.fn();
const spyProvider: AnalyticsProvider = {
  meta: { id: "spy", name: "Spy" },
  capabilities: {
    personReads: false,
    personWrites: true,
    identityMerge: true,
  },
  getPersonProperties: vi.fn(async () => ({})),
  setPersonProperties: vi.fn(async () => {}),
  mergeIdentities: vi.fn(),
  capture,
};

// Build ONE container with the mirror ENABLED via the GROUP arm — the group form
// only registers, so `defaultProvider: "spy"` is required to make the spy the
// resolved active provider. `eventMirror: { enabled: true }` installs the
// ingest→analytics capture config on the container singleton, so the POST
// /v1/events path mirrors without threading.
const container = createHogsendClient({
  analytics: {
    provider: spyProvider,
    defaultProvider: "spy",
    eventMirror: { enabled: true },
  },
  overrides: { hatchet: mockHatchet },
});
// Guard — the spy IS the resolved active provider (no real PostHog provider
// wins resolution and silently swallows the capture calls).
if (container.analytics !== spyProvider) {
  throw new Error(
    "spy analytics provider is not the active container provider",
  );
}
const app = createApp(container);
const { db, registry, hatchet, logger } = container;

const AUTH_HEADER = {
  Authorization: `Bearer ${process.env.ADMIN_API_KEY}`,
  "Content-Type": "application/json",
};

const RUN = `mirror-${Date.now()}`;

// Per-case userIds so rows don't collide; every key is pushed for cleanup.
const cleanupKeys: string[] = [];
function userId(n: string): string {
  const key = `${RUN}-${n}`;
  cleanupKeys.push(key);
  return key;
}

/** Direct ingestEvent with the spy threaded explicitly + the enabled mirror.
 *  Full control over `source`/`eventMirror` per case. */
function ingest(
  event: {
    event: string;
    userId?: string;
    userEmail?: string;
    source?: string;
    idempotencyKey?: string;
    eventProperties: Record<string, unknown>;
  },
  eventMirror: { enabled: boolean; allow?: string[]; deny?: string[] },
) {
  return ingestEvent({
    db,
    registry,
    hatchet,
    logger,
    analytics: spyProvider,
    eventMirror,
    event,
  });
}

beforeEach(() => {
  capture.mockClear();
});

afterAll(async () => {
  if (cleanupKeys.length > 0) {
    await db.delete(userEvents).where(inArray(userEvents.userId, cleanupKeys));
  }
  await container.dbClient.end({ timeout: 5 }).catch(() => {});
});

// ===========================================================================
// (1) Mirrors under the resolved key. A userId-identified contact's resolvedKey
// IS that userId (external_id ?? anonymous_id ?? id).
// ===========================================================================
describe("mirrors under the resolved key", () => {
  it("captures the event with distinctId = the resolved userId and the eventProperties", async () => {
    const u = userId("u1");
    const res = await ingest(
      { event: "feature.used", userId: u, eventProperties: { plan: "pro" } },
      { enabled: true },
    );
    expect(res.stored).toBe(true);
    expect(capture).toHaveBeenCalledWith({
      distinctId: u,
      event: "feature.used",
      properties: { plan: "pro" },
    });
  });
});

// ===========================================================================
// (2) source "posthog" is NEVER mirrored (re-capturing a PostHog-origin event
// would loop).
// ===========================================================================
describe("source posthog is never mirrored", () => {
  it("does not capture when the event entered from PostHog", async () => {
    const u = userId("u2");
    await ingest(
      {
        event: "feature.used",
        userId: u,
        source: "posthog",
        eventProperties: { plan: "pro" },
      },
      { enabled: true },
    );
    expect(capture).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// (3) Disabled — master switch off ⇒ no capture.
// ===========================================================================
describe("disabled mirror", () => {
  it("does not capture when eventMirror.enabled is false", async () => {
    const u = userId("u3");
    await ingest(
      { event: "feature.used", userId: u, eventProperties: {} },
      { enabled: false },
    );
    expect(capture).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// (4) Allow/deny by event name.
// ===========================================================================
describe("allow/deny by event name", () => {
  it("does not capture a denied event", async () => {
    const u = userId("u4-deny");
    await ingest(
      { event: "email.opened", userId: u, eventProperties: {} },
      { enabled: true, deny: ["email.opened"] },
    );
    expect(capture).not.toHaveBeenCalled();
  });

  it("does not capture an event outside the allow-list", async () => {
    const u = userId("u4-allow-miss");
    await ingest(
      { event: "feature.used", userId: u, eventProperties: {} },
      { enabled: true, allow: ["discord:message"] },
    );
    expect(capture).not.toHaveBeenCalled();
  });

  it("captures an allow-listed event exactly once", async () => {
    const u = userId("u4-allow-hit");
    await ingest(
      { event: "discord:message", userId: u, eventProperties: {} },
      { enabled: true, allow: ["discord:message"] },
    );
    expect(capture).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// (5) Idempotent replay — the mirror sits on the fresh-insert side of the
// idempotency guard, so a same-key replay returns early (stored:false) before
// `capture` and never double-mirrors.
// ===========================================================================
describe("idempotent replay does not double-mirror", () => {
  it("captures once across two ingests sharing an idempotencyKey", async () => {
    const u = userId("u5");
    const idempotencyKey = `${RUN}-u5-key`;
    const first = await ingest(
      { event: "feature.used", userId: u, idempotencyKey, eventProperties: {} },
      { enabled: true },
    );
    expect(first.stored).toBe(true);
    const replay = await ingest(
      { event: "feature.used", userId: u, idempotencyKey, eventProperties: {} },
      { enabled: true },
    );
    expect(replay.stored).toBe(false);
    expect(capture).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// (6) POST /v1/events integration — the singleton mirror path. The route
// threads `analytics`; the container build enabled the singleton config, so the
// mirror fires without per-call `eventMirror`.
// ===========================================================================
describe("POST /v1/events mirrors via the container singleton", () => {
  it("captures the routed event under the resolved userId", async () => {
    const u = userId("u6");
    const res = await app.request("/v1/events", {
      method: "POST",
      headers: AUTH_HEADER,
      body: JSON.stringify({
        name: "feature.used",
        userId: u,
        eventProperties: { ref: "x" },
      }),
    });
    expect(res.status).toBe(202);
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({ distinctId: u, event: "feature.used" }),
    );
  });
});

// ===========================================================================
// (7) Best-effort — a throwing `capture` must NOT fail the ingest. The mirror
// is wrapped in try/catch and logged at debug; the ingest still resolves
// stored:true.
// ===========================================================================
describe("mirror is best-effort", () => {
  it("still stores the event when capture throws", async () => {
    const u = userId("u7");
    capture.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    const res = await ingest(
      { event: "feature.used", userId: u, eventProperties: {} },
      { enabled: true },
    );
    expect(res.stored).toBe(true);
  });
});
