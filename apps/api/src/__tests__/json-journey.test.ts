/**
 * JSON-defined journeys (JourneySpec) — end-to-end over the REAL machinery:
 *
 *  - `journeyFromSpec` definition-time validation (shape, referential checks,
 *    template keys against the registry)
 *  - the step interpreter driven through the REAL journey boundary, REAL
 *    `createJourneyContext`, REAL `createTrackedMailer`, and REAL Postgres —
 *    including the replay-from-top exactly-once guarantee (same harness as
 *    journey-run-replay.test.ts, nothing mocked on the dedup path)
 *  - `specToGraph` node-id conventions (the join keys Studio metrics rely on)
 *
 * DB: the shared TimescaleDB on port 5434; RUN-namespaced rows, cleaned in
 * afterAll.
 */

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

const { emailSends, journeyStates } = await import("@hogsend/db");
const { eq, inArray } = await import("drizzle-orm");
const {
  createHogsendClient,
  createJourneyContext,
  createMemoize,
  createTrackedMailer,
  journeyFromSpec,
  makeSpecRun,
  runWithJourneyBoundary,
  setEmailService,
  specToGraph,
} = await import("@hogsend/engine");
const { journeySpecSchema } = await import("@hogsend/core");
type JourneyBoundary = import("@hogsend/engine").JourneyBoundary;
type EmailProvider = import("@hogsend/engine").EmailProvider;
type JourneySpec = import("@hogsend/core").JourneySpec;
type JourneyContext = import("@hogsend/core/types").JourneyContext;
type JourneyUser = import("@hogsend/core/types").JourneyUser;
const { templates } = await import("../emails/index.js");

const mockHatchet = {
  durableTask: () => ({ run: () => {}, runNoWait: () => {} }),
  task: () => ({ run: () => {}, runNoWait: () => {} }),
  events: { push: async () => {} },
  runs: { cancel: () => {}, get: () => {} },
  worker: () => {},
} as unknown as ReturnType<typeof createHogsendClient>["hatchet"];

const container = createHogsendClient({ overrides: { hatchet: mockHatchet } });
const { db } = container;

const RUN = `jsonj-${Date.now()}`;
const JOURNEY_ID = `${RUN}-spec`;

// --- harness (mirrors journey-run-replay.test.ts) ---------------------------

let providerSends: Array<{ to: string | string[] }> = [];
function makeCountingProvider(): EmailProvider {
  let n = 0;
  return {
    meta: { id: "resend", name: "counting-test" },
    capabilities: { nativeTracking: false },
    send: async (opts) => {
      providerSends.push({ to: opts.to });
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

async function seedState(userId: string): Promise<string> {
  const [row] = await db
    .insert(journeyStates)
    .values({
      userId,
      userEmail: `${userId}@example.com`,
      journeyId: JOURNEY_ID,
      currentNodeId: "start",
      status: "active",
    })
    .returning({ id: journeyStates.id });
  return row?.id ?? "";
}

function makeBoundary(stateId: string, runAnchor?: string): JourneyBoundary {
  return {
    stateId,
    runAnchor: runAnchor ?? stateId,
    currentLabel: undefined,
    seenKeys: new Set<string>(),
    memoize: createMemoize({}),
  };
}

function makeCtx(stateId: string, userId: string): JourneyContext {
  return createJourneyContext({
    db: db as Parameters<typeof createJourneyContext>[0]["db"],
    hatchet: mockHatchet as Parameters<
      typeof createJourneyContext
    >[0]["hatchet"],
    hatchetCtx: {
      sleepFor: (async () => ({})) as unknown as (
        d: unknown,
      ) => Promise<unknown>,
      // Resolves with no `event` key → every waitForEvent times out. The
      // wait_result branch tests pivot on exactly this.
      waitFor: (async () => ({})) as unknown as (
        c: unknown,
      ) => Promise<Record<string, unknown>>,
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal registry stub
    registry: { get: () => undefined } as any,
    // biome-ignore lint/suspicious/noExplicitAny: minimal logger stub
    logger: { info: () => {}, warn: () => {}, error: () => {} } as any,
    stateId,
    userId,
    userEmail: `${userId}@example.com`,
    journeyContext: {},
    resolvedTimezone: "UTC",
  }) as unknown as JourneyContext;
}

function makeUser(
  userId: string,
  stateId: string,
  properties: JourneyUser["properties"] = {},
): JourneyUser {
  return {
    id: userId,
    email: `${userId}@example.com`,
    properties,
    stateId,
    journeyId: JOURNEY_ID,
    journeyName: "Spec test journey",
  };
}

beforeEach(() => {
  installRealMailer();
});

afterAll(async () => {
  const states = await db
    .select({ id: journeyStates.id })
    .from(journeyStates)
    .where(eq(journeyStates.journeyId, JOURNEY_ID));
  const ids = states.map((s) => s.id);
  if (ids.length > 0) {
    await db.delete(emailSends).where(inArray(emailSends.journeyStateId, ids));
    await db.delete(journeyStates).where(inArray(journeyStates.id, ids));
  }
});

// --- fixture spec ------------------------------------------------------------

const SPEC = {
  specVersion: 1,
  id: JOURNEY_ID,
  meta: {
    name: "Spec test journey",
    enabled: true,
    trigger: { event: `${RUN}.start` },
    entryLimit: "unlimited",
    suppress: { minutes: 1 },
  },
  steps: [
    {
      id: "hello",
      type: "send_email",
      template: "welcome",
      subject: "Hello from a spec",
    },
    { id: "settle", type: "sleep", duration: { minutes: 5 } },
    {
      id: "is-pro",
      type: "branch",
      if: { type: "property", property: "plan", operator: "eq", value: "pro" },
      yes: [
        {
          id: "pro-offer",
          type: "send_email",
          template: "conversion-winback-offer",
          subject: "Pro perk inside",
        },
      ],
      no: [{ id: "mark-basic", type: "checkpoint" }],
    },
  ],
} satisfies JourneySpec;

// --- tests -------------------------------------------------------------------

describe("journeyFromSpec — definition-time validation", () => {
  it("adapts a valid spec into an ordinary DefinedJourney", () => {
    const journey = journeyFromSpec(SPEC);
    expect(journey.meta.id).toBe(JOURNEY_ID);
    expect(journey.meta.trigger.event).toBe(`${RUN}.start`);
    expect(journey.task).toBeDefined();
  });

  it("rejects duplicate step ids across branch arms", () => {
    const bad = {
      ...SPEC,
      steps: [
        { id: "dup", type: "checkpoint" },
        {
          id: "b",
          type: "branch",
          if: { type: "property", property: "x", operator: "exists" },
          yes: [{ id: "dup", type: "checkpoint" }],
        },
      ],
    };
    expect(() => journeyFromSpec(bad)).toThrow(/duplicate step id "dup"/);
  });

  it("rejects a wait_result referencing a non-preceding wait", () => {
    const bad = {
      ...SPEC,
      steps: [
        {
          id: "b",
          type: "branch",
          if: { type: "wait_result", of: "never-declared", fired: true },
          yes: [],
        },
      ],
    };
    expect(() => journeyFromSpec(bad)).toThrow(
      /not a preceding wait_for_event/,
    );
  });

  it("rejects an unregistered template key when the registry is provided", () => {
    const bad = {
      ...SPEC,
      steps: [
        {
          id: "ghost",
          type: "send_email",
          template: "activation/advanced",
          subject: "…",
        },
      ],
    };
    expect(() =>
      journeyFromSpec(bad, { templateKeys: new Set(Object.keys(templates)) }),
    ).toThrow(/not in the email registry/);
    // Without the registry the same spec passes shape validation (soft mode).
    expect(() => journeyFromSpec(bad)).not.toThrow();
  });
});

describe("spec interpreter — real boundary, mailer, and Postgres", () => {
  const run = makeSpecRun(journeySpecSchema.parse(SPEC));

  it("walks send → sleep → branch(else) and keys sends by step id", async () => {
    const userId = `${RUN}-basic`;
    const stateId = await seedState(userId);
    const user = makeUser(userId, stateId, { plan: "free" });

    await runWithJourneyBoundary(makeBoundary(stateId), () =>
      run(user, makeCtx(stateId, userId)),
    );

    // One provider call (the else arm sends nothing)…
    expect(providerSends).toHaveLength(1);
    // …one email_sends row, keyed by the step id as the idempotency site.
    const rows = await db
      .select({
        idempotencyKey: emailSends.idempotencyKey,
        templateKey: emailSends.templateKey,
      })
      .from(emailSends)
      .where(eq(emailSends.journeyStateId, stateId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.templateKey).toBe("welcome");
    expect(rows[0]?.idempotencyKey).toContain(":hello:");
    // The else-arm checkpoint parked currentNodeId on the step id.
    const [state] = await db
      .select({ currentNodeId: journeyStates.currentNodeId })
      .from(journeyStates)
      .where(eq(journeyStates.id, stateId));
    expect(state?.currentNodeId).toBe("mark-basic");
  });

  it("takes the then-arm when the property condition matches", async () => {
    const userId = `${RUN}-pro`;
    const stateId = await seedState(userId);
    const user = makeUser(userId, stateId, { plan: "pro" });

    await runWithJourneyBoundary(makeBoundary(stateId), () =>
      run(user, makeCtx(stateId, userId)),
    );

    expect(providerSends).toHaveLength(2);
    const rows = await db
      .select({ templateKey: emailSends.templateKey })
      .from(emailSends)
      .where(eq(emailSends.journeyStateId, stateId));
    expect(rows.map((r) => r.templateKey).sort()).toEqual([
      "conversion-winback-offer",
      "welcome",
    ]);
  });

  it("is exactly-once across a replay-from-top (same run anchor)", async () => {
    const userId = `${RUN}-replay`;
    const stateId = await seedState(userId);
    const user = makeUser(userId, stateId, { plan: "pro" });
    const anchor = `run-${stateId}`;

    await runWithJourneyBoundary(makeBoundary(stateId, anchor), () =>
      run(user, makeCtx(stateId, userId)),
    );
    // Replay: fresh boundary (new seenKeys), same anchor — like a Hatchet
    // replay after a worker crash.
    await runWithJourneyBoundary(makeBoundary(stateId, anchor), () =>
      run(user, makeCtx(stateId, userId)),
    );

    // Two logical sends, exactly two provider calls TOTAL across both passes.
    expect(providerSends).toHaveLength(2);
    const rows = await db
      .select({ id: emailSends.id })
      .from(emailSends)
      .where(eq(emailSends.journeyStateId, stateId));
    expect(rows).toHaveLength(2);
  });

  it("branches on wait_result (timeout path) via a real waitForEvent", async () => {
    const spec = journeySpecSchema.parse({
      ...SPEC,
      steps: [
        {
          id: "await-reply",
          type: "wait_for_event",
          event: `${RUN}.reply`,
          timeout: { hours: 1 },
        },
        {
          id: "replied",
          type: "branch",
          if: { type: "wait_result", of: "await-reply", fired: true },
          yes: [
            {
              id: "thanks",
              type: "send_email",
              template: "welcome",
              subject: "Thanks!",
            },
          ],
          no: [{ id: "went-quiet", type: "checkpoint" }],
        },
      ],
    });
    const waitRun = makeSpecRun(spec);

    const userId = `${RUN}-quiet`;
    const stateId = await seedState(userId);
    const user = makeUser(userId, stateId);

    await runWithJourneyBoundary(makeBoundary(stateId), () =>
      waitRun(user, makeCtx(stateId, userId)),
    );

    // The stubbed hatchet waitFor resolves without an event → timeout → else.
    expect(providerSends).toHaveLength(0);
    const [state] = await db
      .select({ currentNodeId: journeyStates.currentNodeId })
      .from(journeyStates)
      .where(eq(journeyStates.id, stateId));
    expect(state?.currentNodeId).toBe("went-quiet");
  });
});

describe("spec interpreter — adversarial edge cases", () => {
  it("two sends of the SAME template on distinct step ids each send once (per-step keying)", async () => {
    // Guards the exactly-once concern: keys derive from run anchor + step-id
    // label + template. Same template, distinct step ids → distinct keys → two
    // sends. If keys collided on the template alone, the second would dedupe.
    const spec = journeySpecSchema.parse({
      ...SPEC,
      steps: [
        { id: "one", type: "send_email", template: "welcome", subject: "1" },
        { id: "two", type: "send_email", template: "welcome", subject: "2" },
      ],
    });
    const run = makeSpecRun(spec);
    const userId = `${RUN}-twin`;
    const stateId = await seedState(userId);
    await runWithJourneyBoundary(makeBoundary(stateId), () =>
      run(makeUser(userId, stateId), makeCtx(stateId, userId)),
    );
    expect(providerSends).toHaveLength(2);
    const rows = await db
      .select({ idempotencyKey: emailSends.idempotencyKey })
      .from(emailSends)
      .where(eq(emailSends.journeyStateId, stateId));
    expect(rows).toHaveLength(2);
    const keys = rows.map((r) => r.idempotencyKey);
    expect(new Set(keys).size).toBe(2); // distinct
    expect(keys.some((k) => k?.includes(":one:"))).toBe(true);
    expect(keys.some((k) => k?.includes(":two:"))).toBe(true);
  });

  it("an `end` inside a nested branch arm halts the OUTER sequence", async () => {
    const spec = journeySpecSchema.parse({
      ...SPEC,
      steps: [
        {
          id: "gate",
          type: "branch",
          if: {
            type: "property",
            property: "vip",
            operator: "eq",
            value: true,
          },
          yes: [{ id: "stop-here", type: "end" }],
          no: [{ id: "note", type: "checkpoint" }],
        },
        // Must NOT run when the yes-arm ended the journey.
        {
          id: "after",
          type: "send_email",
          template: "welcome",
          subject: "should not send for vip",
        },
      ],
    });
    const run = makeSpecRun(spec);
    const userId = `${RUN}-vip-end`;
    const stateId = await seedState(userId);
    await runWithJourneyBoundary(makeBoundary(stateId), () =>
      run(makeUser(userId, stateId, { vip: true }), makeCtx(stateId, userId)),
    );
    // yes-arm hit `end` → the trailing send never runs.
    expect(providerSends).toHaveLength(0);
  });

  it("evaluates nested composite AND/OR against enrollment properties", async () => {
    const spec = journeySpecSchema.parse({
      ...SPEC,
      steps: [
        {
          id: "combo",
          type: "branch",
          if: {
            type: "composite",
            operator: "and",
            conditions: [
              {
                type: "property",
                property: "plan",
                operator: "eq",
                value: "pro",
              },
              {
                type: "composite",
                operator: "or",
                conditions: [
                  {
                    type: "property",
                    property: "vip",
                    operator: "eq",
                    value: true,
                  },
                  {
                    type: "property",
                    property: "seats",
                    operator: "gte",
                    value: 5,
                  },
                ],
              },
            ],
          },
          yes: [
            {
              id: "hit",
              type: "send_email",
              template: "welcome",
              subject: "hi",
            },
          ],
          no: [{ id: "miss", type: "checkpoint" }],
        },
      ],
    });
    const run = makeSpecRun(spec);
    // pro AND (not vip) AND seats=8 → OR arm true via seats → overall true.
    const s1 = await seedState(`${RUN}-combo-y`);
    await runWithJourneyBoundary(makeBoundary(s1), () =>
      run(
        makeUser(`${RUN}-combo-y`, s1, { plan: "pro", vip: false, seats: 8 }),
        makeCtx(s1, `${RUN}-combo-y`),
      ),
    );
    expect(providerSends).toHaveLength(1);

    installRealMailer(); // reset counter
    // pro AND (not vip) AND seats=2 → OR arm false → overall false.
    const s2 = await seedState(`${RUN}-combo-n`);
    await runWithJourneyBoundary(makeBoundary(s2), () =>
      run(
        makeUser(`${RUN}-combo-n`, s2, { plan: "pro", vip: false, seats: 2 }),
        makeCtx(s2, `${RUN}-combo-n`),
      ),
    );
    expect(providerSends).toHaveLength(0);
    const [state] = await db
      .select({ currentNodeId: journeyStates.currentNodeId })
      .from(journeyStates)
      .where(eq(journeyStates.id, s2));
    expect(state?.currentNodeId).toBe("miss");
  });

  it("wait_result for a wait on an UNWALKED sibling arm treats fired as false", async () => {
    // The referenced wait lives on a branch arm this enrollment never enters,
    // so its outcome is absent from the walk-local map. `fired: true` must be
    // false (the event demonstrably did not fire on this path).
    const spec = journeySpecSchema.parse({
      ...SPEC,
      steps: [
        {
          id: "route",
          type: "branch",
          if: {
            type: "property",
            property: "path",
            operator: "eq",
            value: "a",
          },
          // Arm A declares the wait; we drive path=b so A is never walked.
          yes: [
            {
              id: "wait-a",
              type: "wait_for_event",
              event: `${RUN}.x`,
              timeout: { hours: 1 },
            },
          ],
          no: [{ id: "note-b", type: "checkpoint" }],
        },
        {
          id: "check",
          type: "branch",
          if: { type: "wait_result", of: "wait-a", fired: true },
          yes: [
            {
              id: "sent",
              type: "send_email",
              template: "welcome",
              subject: "x",
            },
          ],
          no: [{ id: "skipped", type: "checkpoint" }],
        },
      ],
    });
    const run = makeSpecRun(spec);
    const userId = `${RUN}-unwalked`;
    const stateId = await seedState(userId);
    await runWithJourneyBoundary(makeBoundary(stateId), () =>
      run(makeUser(userId, stateId, { path: "b" }), makeCtx(stateId, userId)),
    );
    // wait-a never ran → fired:true is false → no-arm → no send.
    expect(providerSends).toHaveLength(0);
    const [state] = await db
      .select({ currentNodeId: journeyStates.currentNodeId })
      .from(journeyStates)
      .where(eq(journeyStates.id, stateId));
    expect(state?.currentNodeId).toBe("skipped");
  });
});

describe("specToGraph — Studio IR conventions", () => {
  it("emits the runtime IR with metric-joinable node ids", () => {
    const graph = specToGraph(journeySpecSchema.parse(SPEC));
    const ids = graph.nodes.map((n) => n.id);

    // Reserved terminals + step nodes under the documented id scheme.
    expect(ids).toContain("start");
    expect(ids).toContain("end-completed");
    expect(ids).toContain("send:hello"); // send:<stepId>
    expect(ids).toContain("settle"); // sleeps keep the authored label
    expect(ids).toContain("is-pro"); // decision keeps the step id
    expect(ids).toContain("send:pro-offer");
    expect(ids).toContain("mark-basic");

    // Full fidelity: spec graphs are never degraded.
    expect(graph.degraded).toBeUndefined();

    // Branch arms carry conditional kinds and rejoin at end-completed.
    const kinds = graph.edges.map((e) => e.kind);
    expect(kinds).toContain("conditional-true");
    expect(kinds).toContain("conditional-false");
    const intoEnd = graph.edges.filter((e) => e.target === "end-completed");
    expect(intoEnd.length).toBeGreaterThanOrEqual(2);

    // Every edge endpoint resolves to a declared node.
    const idSet = new Set(ids);
    for (const edge of graph.edges) {
      expect(idSet.has(edge.source)).toBe(true);
      expect(idSet.has(edge.target)).toBe(true);
    }

    // The send node carries the template for Studio's preview panel.
    const send = graph.nodes.find((n) => n.id === "send:hello");
    expect(send?.meta?.template).toBe("welcome");
  });

  it("gives distinct node ids to two trigger steps that fire the same event", () => {
    // Node ids must be unique for the canvas even when the event repeats; the
    // trigger node keys on the step id, not the event.
    const graph = specToGraph(
      journeySpecSchema.parse({
        ...SPEC,
        steps: [
          { id: "fire-a", type: "trigger_event", event: "recompute" },
          { id: "fire-b", type: "trigger_event", event: "recompute" },
        ],
      }),
    );
    const ids = graph.nodes.map((n) => n.id);
    expect(ids).toContain("trigger:fire-a");
    expect(ids).toContain("trigger:fire-b");
    // No duplicate ids anywhere in the graph.
    expect(new Set(ids).size).toBe(ids.length);
  });
});
