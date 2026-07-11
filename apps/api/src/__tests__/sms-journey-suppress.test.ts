/**
 * `meta.suppress` enforcement for the SMS channel — the SMS mirror of the core
 * journey-suppress invariant (see journey-suppress.test.ts for the full email
 * matrix). Drives the REAL `defineJourney` durable-task `fn` against the Docker
 * Postgres: a re-enrollment inside the suppress window must skip the SMS send
 * (`journey_suppressed`, no provider call, no `sms_sends` row) while the run
 * still completes, and a zero suppress leaves the guard inert.
 */

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";

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

const { contacts, journeyStates, smsSends, userEvents } = await import(
  "@hogsend/db"
);
const { eq, inArray } = await import("drizzle-orm");
const {
  createHogsendClient,
  defineJourney,
  hours,
  sendSms,
  setJourneyRegistry,
} = await import("@hogsend/engine");
const { JourneyRegistry } = await import("@hogsend/core/registry");
type DurationObject = import("@hogsend/core").DurationObject;

const React = (await import("react")).default;
const { Text } = await import("react-email");
const { defineSmsProvider } = await import("@hogsend/core");

let providerSends = 0;
const fakeProvider = defineSmsProvider({
  meta: { id: "fake-sms", name: "Fake SMS" },
  capabilities: {},
  async send() {
    providerSends += 1;
    return { id: `SM_${providerSends}` };
  },
  verifyWebhook() {
    throw new Error("unused");
  },
  parseWebhook() {
    throw new Error("unused");
  },
});

const TestSms = () => React.createElement(Text, null, "suppress test");

const client = createHogsendClient({
  sms: {
    provider: fakeProvider,
    from: "+15005550006",
    // biome-ignore lint/suspicious/noExplicitAny: minimal test registry
    templates: { "t-sms": { component: TestSms, category: "journey" } } as any,
  },
});
const { db } = client;

const RUN = `sms-suppr-${Date.now()}`;
const createdUsers: string[] = [];
function newUser(): string {
  const id = randomUUID();
  createdUsers.push(id);
  return id;
}

function makeSmsSuppressJourney(opts: {
  journeyId: string;
  event: string;
  suppress: DurationObject;
  phone: string;
}) {
  return defineJourney({
    meta: {
      id: opts.journeyId,
      name: "SMS suppress test",
      enabled: true,
      trigger: { event: opts.event },
      entryLimit: "unlimited",
      suppress: opts.suppress,
    },
    // No journeyStateId: the engine auto-attributes the send to the boundary's
    // enrollment — this test doubles as the proof of that auto-fill.
    run: async (user) => {
      await sendSms({
        to: opts.phone,
        userId: user.id,
        template: "t-sms" as never,
      });
    },
  });
}

function grabFn(): CapturedFn {
  const fn = mockFnHolder.fn;
  if (!fn) throw new Error("durable fn was not captured");
  return fn;
}

function input(userId: string) {
  return { userId, userEmail: `${userId}@example.com`, properties: {} };
}

function makeCtx(runId: string): Record<string, unknown> {
  return {
    workflowRunId: () => runId,
    sleepFor: async () => {},
    waitFor: async () => ({}),
    now: async () => new Date(),
  };
}

function registerJourneys(
  ...journeys: Array<ReturnType<typeof defineJourney>>
): void {
  const registry = new JourneyRegistry();
  for (const j of journeys) registry.register(j.meta);
  setJourneyRegistry(registry);
}

async function countSmsRows(userId: string): Promise<number> {
  const rows = await db
    .select({ id: smsSends.id })
    .from(smsSends)
    .where(eq(smsSends.userId, userId));
  return rows.length;
}

afterAll(async () => {
  if (createdUsers.length === 0) return;
  await db.delete(smsSends).where(inArray(smsSends.userId, createdUsers));
  await db
    .delete(journeyStates)
    .where(inArray(journeyStates.userId, createdUsers));
  await db.delete(userEvents).where(inArray(userEvents.userId, createdUsers));
  await db.delete(contacts).where(inArray(contacts.externalId, createdUsers));
});

describe("meta.suppress — SMS send-time enforcement", () => {
  it("re-enrollment inside the window skips the SMS (no provider call, no row, run completes)", async () => {
    const userId = newUser();
    const phone = `+1555${Math.floor(1000000 + Math.random() * 8999999)}`;
    const journey = makeSmsSuppressJourney({
      journeyId: `${RUN}-j1`,
      event: `${RUN}-e1`,
      suppress: hours(4),
      phone,
    });
    registerJourneys(journey);
    const fn = grabFn();

    const before = providerSends;
    const a = (await fn(input(userId), makeCtx(`${RUN}-wfr-1a`))) as {
      status: string;
    };
    expect(a.status).toBe("completed");
    expect(providerSends - before).toBe(1);
    expect(await countSmsRows(userId)).toBe(1);

    const b = (await fn(input(userId), makeCtx(`${RUN}-wfr-1b`))) as {
      status: string;
    };
    expect(b.status).toBe("completed");
    expect(providerSends - before).toBe(1);
    expect(await countSmsRows(userId)).toBe(1);
  });

  it("a zero suppress duration leaves the guard inert (both enrollments text)", async () => {
    const userId = newUser();
    const phone = `+1555${Math.floor(1000000 + Math.random() * 8999999)}`;
    const journey = makeSmsSuppressJourney({
      journeyId: `${RUN}-j2`,
      event: `${RUN}-e2`,
      suppress: hours(0),
      phone,
    });
    registerJourneys(journey);
    const fn = grabFn();

    const before = providerSends;
    await fn(input(userId), makeCtx(`${RUN}-wfr-2a`));
    await fn(input(userId), makeCtx(`${RUN}-wfr-2b`));
    expect(providerSends - before).toBe(2);
    expect(await countSmsRows(userId)).toBe(2);
  });
});
