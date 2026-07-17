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

type LiftEntry = import("@hogsend/engine").ImpactDigestLiftEntry;
type ShippedEntry = import("@hogsend/engine").ImpactDigestShippedEntry;

// The workflow file is not exported from @hogsend/engine yet (Tasks 3-5
// still fill it in), so it's loaded at runtime through Vite. A LITERAL
// static import into another package's src would pull those files into
// THIS package's TS program and trip rootDir (TS6059) under
// `tsc --noEmit`; the variable specifier keeps tsc out of it (same idiom
// as provision-posthog-loop.test.ts / analytics-admin.test.ts).
const impactDigestModulePath = new URL(
  "../../../../packages/engine/src/workflows/impact-digest.ts",
  import.meta.url,
).pathname;
const { assembleDigestEntries, deriveDigestWindow } = (await import(
  /* @vite-ignore */ impactDigestModulePath
)) as {
  deriveDigestWindow: (opts: { lastDeliveryAt: Date | null; now: Date }) => {
    since: Date;
    until: Date;
  };
  assembleDigestEntries: (opts: {
    lift: LiftEntry[];
    shipped: ShippedEntry[];
    cap: number;
  }) => { entries: (LiftEntry | ShippedEntry)[]; truncated: boolean };
};

function liftEntry(
  overrides: Partial<LiftEntry> & { journeyId: string; winProbability: number },
): LiftEntry {
  return {
    kind: "lift",
    causal: true,
    journeyName: null,
    goalDefinitionId: null,
    windowDays: 90,
    direction: "up",
    treatment: { contacts: 100, converters: 10, rate: 0.1 },
    control: { contacts: 100, converters: 5, rate: 0.05 },
    liftPercent: 100,
    previousWinProbability: null,
    smallSample: false,
    ...overrides,
  };
}

function shippedEntry(
  overrides: Partial<ShippedEntry> & { journeyId: string; firstSeenAt: string },
): ShippedEntry {
  return {
    kind: "shipped",
    causal: false,
    journeyName: null,
    versionHash: "aaaaaaaaaaaa",
    versionLabel: null,
    change: "new_version",
    previousVersionLabel: null,
    goalDefinitionId: null,
    current: {
      versionHash: "aaaaaaaaaaaa",
      versionLabel: null,
      enrollmentsAllTime: 10,
      converters: 1,
      conversionRate: 0.1,
      firstSeenAt: overrides.firstSeenAt,
      exposureDays: 3,
    },
    previous: null,
    ...overrides,
  };
}

describe("deriveDigestWindow (watermark)", () => {
  const now = new Date("2026-07-20T09:00:00.000Z");

  it("first-ever run defaults to a 7-day window", () => {
    const { since, until } = deriveDigestWindow({ lastDeliveryAt: null, now });
    expect(until.toISOString()).toBe(now.toISOString());
    expect(since.toISOString()).toBe(
      new Date(now.getTime() - 7 * DAY).toISOString(),
    );
  });

  it("uses the last delivery time as the watermark", () => {
    const last = new Date(now.getTime() - 3 * DAY);
    const { since } = deriveDigestWindow({ lastDeliveryAt: last, now });
    expect(since.toISOString()).toBe(last.toISOString());
  });

  it("clamps a stale watermark to 30 days (self-healing after pruning)", () => {
    const last = new Date(now.getTime() - 45 * DAY);
    const { since } = deriveDigestWindow({ lastDeliveryAt: last, now });
    expect(since.toISOString()).toBe(
      new Date(now.getTime() - 30 * DAY).toISOString(),
    );
  });
});

describe("assembleDigestEntries (cap + ordering)", () => {
  it("orders lift by desc |winProbability − 0.5| first, then shipped by desc firstSeenAt", () => {
    const nearCoin = liftEntry({ journeyId: "j-near", winProbability: 0.97 });
    const extreme = liftEntry({
      journeyId: "j-extreme",
      winProbability: 0.02,
      direction: "down",
    });
    const older = shippedEntry({
      journeyId: "j-old",
      firstSeenAt: "2026-07-14T00:00:00.000Z",
    });
    const newer = shippedEntry({
      journeyId: "j-new",
      firstSeenAt: "2026-07-19T00:00:00.000Z",
    });
    const { entries, truncated } = assembleDigestEntries({
      lift: [nearCoin, extreme],
      shipped: [older, newer],
      cap: 50,
    });
    expect(entries.map((e) => e.journeyId)).toEqual([
      "j-extreme",
      "j-near",
      "j-new",
      "j-old",
    ]);
    expect(truncated).toBe(false);
  });

  it("caps at `cap` entries and reports truncated", () => {
    const lift = Array.from({ length: 30 }, (_, i) =>
      liftEntry({
        journeyId: `l-${String(i).padStart(2, "0")}`,
        winProbability: 0.99,
      }),
    );
    const shipped = Array.from({ length: 30 }, (_, i) =>
      shippedEntry({
        journeyId: `s-${i}`,
        firstSeenAt: "2026-07-19T00:00:00.000Z",
      }),
    );
    const { entries, truncated } = assembleDigestEntries({
      lift,
      shipped,
      cap: 50,
    });
    expect(entries).toHaveLength(50);
    expect(truncated).toBe(true);
    expect(entries.slice(0, 30).every((e) => e.kind === "lift")).toBe(true);
  });
});
