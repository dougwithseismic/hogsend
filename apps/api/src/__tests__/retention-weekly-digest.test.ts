/**
 * REAL-Postgres proof for the `retention-weekly-digest` dogfood journey.
 *
 * Drives the ACTUAL exported journey's durable-task `fn` (not a hand-rolled
 * stand-in) against the Docker Postgres on :5434 — real `ctx.digest`, real
 * `createTrackedMailer` rendering the real `retention-weekly-digest` React
 * template to HTML, a counting `vi.fn` provider capturing that HTML. Only the
 * Hatchet client is mocked (to capture the `fn` and stub `events.push`).
 *
 * It pins the journey contract: a burst of `feature.used` in the window folds
 * into ONE send whose props carry the digested, `Object.groupBy`-batched stats
 * — and the template renders those props without throwing.
 */

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Capture the durable-task `fn` `defineJourney` hands to `hatchet.durableTask`
// so we can drive it directly. The holder is `mock`-prefixed so vitest allows
// the hoisted mock factory to close over it.
type CapturedFn = (input: unknown, ctx: unknown) => Promise<unknown>;
const mockFnHolder: { fn: CapturedFn | undefined } = { fn: undefined };
vi.mock("../../../../packages/engine/src/lib/hatchet.js", () => ({
  hatchet: {
    durableTask: vi.fn((cfg: { fn: CapturedFn }) => {
      mockFnHolder.fn = cfg.fn;
      return { run: vi.fn(), runNoWait: vi.fn(), runAndWait: vi.fn() };
    }),
    task: vi.fn(() => ({ run: vi.fn(), runNoWait: vi.fn() })),
    events: { push: vi.fn(async () => {}) },
    runs: { cancel: vi.fn(async () => {}), get: vi.fn() },
    worker: vi.fn(),
  },
}));

const { contacts, emailSends, journeyStates, userEvents } = await import(
  "@hogsend/db"
);
const { eq, inArray } = await import("drizzle-orm");
const {
  createHogsendClient,
  createTrackedMailer,
  setEmailService,
  setJourneyRegistry,
} = await import("@hogsend/engine");
type EmailProvider = import("@hogsend/engine").EmailProvider;
type DigestResult = import("@hogsend/core").DigestResult;
const { JourneyRegistry } = await import("@hogsend/core/registry");
const { templates } = await import("../emails/index.js");
const { Events } = await import("../journeys/constants/index.js");
// Import AFTER the hatchet mock so `defineJourney` captures the real journey's
// `fn` into `mockFnHolder`.
const { retentionWeeklyDigest } = await import(
  "../journeys/retention-weekly-digest.js"
);

const container = createHogsendClient();
const { db } = container;

const RUN = `retdig-${Date.now()}`;
const createdUsers: string[] = [];
function newUser(): string {
  const id = randomUUID();
  createdUsers.push(id);
  return id;
}

// Capture every provider send WITH its rendered HTML so a test can prove the
// digested props actually reached — and rendered through — the real template.
let providerSends: Array<{ to: string | string[]; html: string }> = [];
function makeCountingProvider(): EmailProvider {
  let n = 0;
  return {
    meta: { id: "resend", name: "counting-test" },
    capabilities: { nativeTracking: false },
    send: async (opts) => {
      providerSends.push({ to: opts.to, html: opts.html });
      n += 1;
      return { id: `prov-msg-${n}` };
    },
    sendBatch: async () => ({ results: [] }),
    verifyWebhook: () => {
      throw new Error("unused");
    },
    parseWebhook: () => {
      throw new Error("unused");
    },
  };
}

function installRealMailer() {
  providerSends = [];
  const mailer = createTrackedMailer(
    {
      defaultFrom: "Hogsend <noreply@hogsend.com>",
      // biome-ignore lint/suspicious/noExplicitAny: real container db threaded in
      db: db as any,
      templates,
    },
    { provider: makeCountingProvider() },
  );
  // biome-ignore lint/suspicious/noExplicitAny: mailer satisfies EmailService
  setEmailService(mailer as any);
}

function registerJourney() {
  const registry = new JourneyRegistry();
  registry.register(retentionWeeklyDigest.meta);
  setJourneyRegistry(registry);
}

function grabFn(): CapturedFn {
  const fn = mockFnHolder.fn;
  if (!fn) throw new Error("durable fn was not captured");
  return fn;
}

function input(userId: string) {
  return { userId, userEmail: `${userId}@example.com`, properties: {} };
}

// Base durable ctx: sleepFor resolves instantly, workflowRunId fixed. The
// digest deadline lands 7d out, so after the instant sleep the flush scan
// covers [now-15m, now] — the seeded events all sit inside that window.
function makeCtx(runId: string): Record<string, unknown> {
  return {
    workflowRunId: () => runId,
    sleepFor: async () => {},
    waitFor: async () => ({}),
    now: async () => new Date(),
  };
}

async function seedFeatureUsed(opts: {
  userId: string;
  feature: string;
  occurredAt: Date;
}) {
  await db.insert(userEvents).values({
    userId: opts.userId,
    event: Events.FEATURE_USED,
    properties: { feature: opts.feature, source: "demo" },
    source: "api",
    occurredAt: opts.occurredAt,
  });
}

async function readDigest(userId: string): Promise<DigestResult | undefined> {
  const [row] = await db
    .select({ context: journeyStates.context })
    .from(journeyStates)
    .where(eq(journeyStates.userId, userId));
  const bag = (row?.context?.__digest__ ?? {}) as Record<string, unknown>;
  return bag["weekly-activity:result"] as DigestResult | undefined;
}

beforeEach(() => {
  installRealMailer();
});

afterAll(async () => {
  if (createdUsers.length === 0) return;
  await db.delete(emailSends).where(inArray(emailSends.userId, createdUsers));
  await db
    .delete(journeyStates)
    .where(inArray(journeyStates.userId, createdUsers));
  await db.delete(userEvents).where(inArray(userEvents.userId, createdUsers));
  await db.delete(contacts).where(inArray(contacts.externalId, createdUsers));
});

describe("retention-weekly-digest journey — real DB + real render", () => {
  it("3 feature.used in the window → ONE send whose rendered HTML carries the grouped digest stats", async () => {
    const userId = newUser();
    const base = Date.now();
    // Two "journeys" actions + one "emails" action, all inside the 15m default
    // lookback so the flush scan collects them.
    await seedFeatureUsed({
      userId,
      feature: "journeys",
      occurredAt: new Date(base - 5 * 60_000),
    });
    await seedFeatureUsed({
      userId,
      feature: "journeys",
      occurredAt: new Date(base - 3 * 60_000),
    });
    await seedFeatureUsed({
      userId,
      feature: "emails",
      occurredAt: new Date(base - 1 * 60_000),
    });

    registerJourney();
    const fn = grabFn();

    const result = (await fn(input(userId), makeCtx(`${RUN}-wfr-1`))) as {
      status: string;
    };
    expect(result.status).toBe("completed");

    // The digest absorbed all three into one recorded set.
    const digest = await readDigest(userId);
    expect(digest?.count).toBe(3);
    expect(digest?.events.map((e) => e.properties?.feature)).toEqual([
      "journeys",
      "journeys",
      "emails",
    ]);

    // Exactly one send — the whole window collapsed into a single email.
    expect(providerSends).toHaveLength(1);

    // The real template rendered the digested, Object.groupBy-batched props to
    // HTML without throwing: the total, each feature label, and each group
    // count are all present.
    const { html } = providerSends[0] as { html: string };
    expect(html).toContain("Your Hogsend week");
    expect(html).toContain("Actions");
    expect(html).toContain("journeys");
    expect(html).toContain("emails");
    // Total actions = 3, journeys group = 2, emails group = 1.
    expect(html).toContain(">3<");
    expect(html).toContain(">2<");
    expect(html).toContain(">1<");
  });

  it("the post-digest send is auto-keyed at the digest site (survives a replay)", async () => {
    const userId = newUser();
    await seedFeatureUsed({
      userId,
      feature: "journeys",
      occurredAt: new Date(Date.now() - 60_000),
    });

    registerJourney();
    const fn = grabFn();
    const runId = `${RUN}-wfr-2`;

    // Drive twice with the SAME run id (models a replay-from-top). The recorded
    // digest + the idempotency-keyed send must yield exactly one provider call.
    await fn(input(userId), makeCtx(runId));
    await fn(input(userId), makeCtx(runId));

    expect(providerSends).toHaveLength(1);
    const [send] = await db
      .select({ key: emailSends.idempotencyKey })
      .from(emailSends)
      .where(eq(emailSends.userId, userId));
    // Site = the nearest authored label, which is the `digest-flushed`
    // checkpoint the run sets between the digest flush and the send.
    expect(send?.key).toBe(
      `journeySend:${runId}:digest-flushed:retention-weekly-digest`,
    );
  });
});
