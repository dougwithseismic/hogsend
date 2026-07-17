import { describe, expect, it, vi } from "vitest";

// DB-touching suite (later blocks): point at the real docker TimescaleDB,
// overriding the vitest.config placeholder DATABASE_URL. Must run before
// the engine import below.
process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// Config-preserving Hatchet mock (mirrors outbound-webhooks-emit.test.ts).
// Mock BOTH the engine's own lib/hatchet.ts (so importing @hogsend/engine
// never dials a live gRPC engine) AND the API's ../lib/hatchet.js.
// Spreading `config` keeps `fn` readable on task objects — later blocks
// invoke `impactDigestTask.fn` directly (the bucket-reconcile seam
// pattern), and `deliverWebhookTask.runNoWait` becomes a no-op so
// emitOutbound inserts delivery rows without dialing the broker.
const { hatchetMock } = vi.hoisted(() => {
  const factory = () => ({
    hatchet: {
      durableTask: vi.fn((config: Record<string, unknown>) => ({
        ...config,
        run: vi.fn(),
        runNoWait: vi.fn(),
        runAndWait: vi.fn(),
      })),
      task: vi.fn((config: Record<string, unknown>) => ({
        ...config,
        run: vi.fn(),
        runNoWait: vi.fn(async () => ({})),
      })),
      events: { push: vi.fn() },
      runs: { cancel: vi.fn(), get: vi.fn() },
      worker: vi.fn(),
    },
  });
  return { hatchetMock: factory };
});

vi.mock("../../../../packages/engine/src/lib/hatchet.ts", () => hatchetMock());
vi.mock("../lib/hatchet.js", () => hatchetMock());

const { posthogDestination, segmentDestination, WEBHOOK_EVENT_TYPES } =
  await import("@hogsend/engine");

const DAY = 86_400_000;

// A frozen impact.digest envelope as the delivery task would hand a preset.
const digestEnvelope = {
  id: "msg_test-digest",
  type: "impact.digest",
  timestamp: "2026-07-20T09:00:00.000Z",
  data: {
    periodKey: "2026-07-20",
    since: "2026-07-13T09:00:00.000Z",
    until: "2026-07-20T09:00:00.000Z",
    entries: [],
    truncated: false,
  },
} as unknown as Parameters<typeof posthogDestination.transform>[0];

const presetLogger = {
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
};

describe("impact.digest catalog membership", () => {
  it("is a member of WEBHOOK_EVENT_TYPES (count 30)", () => {
    expect(WEBHOOK_EVENT_TYPES).toContain("impact.digest");
    expect(WEBHOOK_EVENT_TYPES).toHaveLength(30);
  });
});

describe("impact.digest destination preset guards", () => {
  it("posthog preset returns null (no person identity — capture would 400)", () => {
    const ctx = {
      endpoint: { config: { apiKey: "phc_test" } },
      logger: presetLogger,
    } as unknown as Parameters<typeof posthogDestination.transform>[1];
    expect(posthogDestination.transform(digestEnvelope, ctx)).toBeNull();
  });

  it("segment preset returns null (no subject — track would be junk)", () => {
    const ctx = {
      endpoint: { config: { writeKey: "sk_test" } },
      logger: presetLogger,
    } as unknown as Parameters<typeof segmentDestination.transform>[1];
    expect(segmentDestination.transform(digestEnvelope, ctx)).toBeNull();
  });
});

void DAY; // used from Task 2 on
