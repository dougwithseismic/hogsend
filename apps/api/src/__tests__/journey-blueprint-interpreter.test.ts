/**
 * Journey Blueprints phase 2 — end-to-end proof of the interpreter + dispatch
 * (spec §5/§6/§14 phase 2), following the journey-enrollment-replay harness:
 * the ENGINE's hatchet singleton is mocked so the durable-task `fn`s are
 * captured and invoked directly with a controllable `hatchetCtx`; NOTHING else
 * is mocked — real Postgres (journey_blueprints / journey_states /
 * email_sends), the real `validateBlueprintGraph`, the real enrollment guards,
 * the real `createJourneyContext` tree-walk primitives, and the real
 * createTrackedMailer with a counting provider.
 *
 * Proves the spec §14 phase-2 loop against one hand-written blueprint:
 * enroll → sleep → decision → send → complete — plus the guard reuse
 * (disabled / entry-limit), execution-time re-validation, replay exactly-once
 * (node-id-derived idempotency keys), ingest dispatch (`checkBlueprintTriggers`
 * → `blueprint:run` push), and blueprint `exitOn` via `checkExits`.
 */

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Capture every durable-task/task `fn` passed to the ENGINE's hatchet
// singleton, keyed by task name, so the interpreter can be invoked directly.
// The holder is `mock`-prefixed so vitest allows the hoisted factory to close
// over it. The mock path targets the engine's own `../lib/hatchet.js` module.
type CapturedFn = (input: unknown, ctx: unknown) => Promise<unknown>;
const mockFns: Record<string, CapturedFn> = {};
vi.mock("../../../../packages/engine/src/lib/hatchet.js", () => ({
  hatchet: {
    durableTask: vi.fn((cfg: { name: string; fn: CapturedFn }) => {
      mockFns[cfg.name] = cfg.fn;
      return { run: vi.fn(), runNoWait: vi.fn(), runAndWait: vi.fn() };
    }),
    task: vi.fn((cfg: { name: string; fn: CapturedFn }) => {
      mockFns[cfg.name] = cfg.fn;
      return { run: vi.fn(), runNoWait: vi.fn() };
    }),
    events: { push: vi.fn(async () => {}) },
    runs: { cancel: vi.fn(async () => {}), get: vi.fn() },
    worker: vi.fn(),
  },
}));

const { contacts, emailSends, journeyBlueprints, journeyStates, userEvents } =
  await import("@hogsend/db");
const { eq, like } = await import("drizzle-orm");
const {
  BLUEPRINT_RUN_EVENT,
  createHogsendClient,
  createTrackedMailer,
  ingestEvent,
  setEmailService,
  setJourneyRegistry,
} = await import("@hogsend/engine");
type EmailProvider = import("@hogsend/engine").EmailProvider;
const { JourneyRegistry } = await import("@hogsend/core/registry");
const { templates } = await import("../emails/index.js");

const container = createHogsendClient();
const { db } = container;

const RUN = `jbp-${Date.now()}`;

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

// A stub DurableContext: workflowRunId is FIXED per logical run (replays reuse
// it); sleepFor/waitFor resolve instantly so the walk flows straight through.
function makeHatchetCtx(workflowRunId: string) {
  return {
    workflowRunId: () => workflowRunId,
    sleepFor: async () => ({}),
    waitFor: async () => ({}),
    now: async () => new Date(),
  };
}

/** The captured interpreter durable fn — registered ONCE at engine import. */
function interpreterFn(): CapturedFn {
  const fn = mockFns["journey-blueprint-interpreter"];
  if (!fn) throw new Error("interpreter durable fn was not captured");
  return fn;
}

/** The spec §14 phase-2 proof graph: enroll → sleep → decision → send → end. */
function nudgeGraph(blueprintId: string) {
  return {
    journeyId: blueprintId,
    nodes: [
      { id: "start", type: "start", title: `${RUN}.enroll` },
      {
        id: "sleep-3d",
        type: "sleep",
        title: "Wait 3 days",
        meta: { duration: { hours: 72 } },
      },
      {
        id: "check-activated",
        type: "decision",
        title: "Activated?",
        meta: {
          conditions: [
            {
              type: "property",
              property: "activated",
              operator: "eq",
              value: true,
            },
          ],
        },
      },
      {
        id: "send-nudge",
        type: "send",
        title: "Send activation nudge",
        meta: { template: "welcome" },
      },
      { id: "end-ok", type: "end-completed", title: "Done" },
    ],
    edges: [
      { id: "e1", source: "start", target: "sleep-3d" },
      { id: "e2", source: "sleep-3d", target: "check-activated" },
      {
        id: "e3",
        source: "check-activated",
        target: "end-ok",
        kind: "conditional-true",
      },
      {
        id: "e4",
        source: "check-activated",
        target: "send-nudge",
        kind: "conditional-false",
      },
      { id: "e5", source: "send-nudge", target: "end-ok" },
    ],
  };
}

/** Minimal linear graph (no waits) — isolates the send-key replay dedup. */
function sendOnlyGraph(blueprintId: string) {
  return {
    journeyId: blueprintId,
    nodes: [
      { id: "start", type: "start", title: `${RUN}.enroll` },
      {
        id: "send-welcome",
        type: "send",
        title: "Send welcome",
        meta: { template: "welcome" },
      },
      { id: "end-ok", type: "end-completed", title: "Done" },
    ],
    edges: [
      { id: "e1", source: "start", target: "send-welcome" },
      { id: "e2", source: "send-welcome", target: "end-ok" },
    ],
  };
}

type BlueprintStatus = "draft" | "enabled" | "disabled";
async function insertBlueprint(opts: {
  id: string;
  graph: Record<string, unknown>;
  status?: BlueprintStatus;
  triggerEvent?: string;
  triggerWhere?: Array<Record<string, unknown>>;
  entryLimit?: "once" | "once_per_period" | "unlimited";
  exitOn?: Array<{ event: string }>;
}) {
  await db.insert(journeyBlueprints).values({
    id: opts.id,
    name: `Blueprint ${opts.id}`,
    status: opts.status ?? "enabled",
    version: 1,
    triggerEvent: opts.triggerEvent ?? `${RUN}.enroll`,
    triggerWhere: opts.triggerWhere,
    entryLimit: opts.entryLimit ?? "unlimited",
    exitOn: opts.exitOn,
    suppress: {},
    graph: opts.graph as never,
    source: "api",
  });
}

function input(
  userId: string,
  opts?: {
    blueprintId?: string;
    properties?: Record<string, string | number | boolean | null>;
  },
) {
  return {
    blueprintId: opts?.blueprintId ?? `${RUN}-bp`,
    blueprintVersion: 1,
    userId,
    userEmail: `${userId}@example.com`,
    triggerProperties: opts?.properties ?? {},
  };
}

beforeEach(() => {
  installRealMailer();
  setJourneyRegistry(new JourneyRegistry());
});

afterAll(async () => {
  await db.delete(emailSends).where(like(emailSends.userId, `${RUN}-%`));
  await db.delete(journeyStates).where(like(journeyStates.userId, `${RUN}-%`));
  await db.delete(userEvents).where(like(userEvents.userId, `${RUN}-%`));
  await db.delete(contacts).where(like(contacts.externalId, `${RUN}-%`));
  await db
    .delete(journeyBlueprints)
    .where(like(journeyBlueprints.id, `${RUN}-%`));
});

describe("journeyBlueprintInterpreter — tree-walk end-to-end", () => {
  it("walks enroll → sleep → decision(false) → send → complete against one hand-written blueprint", async () => {
    const blueprintId = `${RUN}-bp`;
    const userId = `${RUN}-walk`;
    await insertBlueprint({ id: blueprintId, graph: nudgeGraph(blueprintId) });

    const wfr = `${RUN}-wfr-walk`;
    const result = (await interpreterFn()(
      input(userId, { properties: { activated: false, name: "Ada" } }),
      makeHatchetCtx(wfr),
    )) as { stateId: string; status: string };

    expect(result.status).toBe("completed");

    // ONE enrollment row, completed, journeyId = the blueprint id, pinned to
    // the enrolled version (spec §12) with the trigger properties preserved.
    const states = await db
      .select()
      .from(journeyStates)
      .where(eq(journeyStates.userId, userId));
    expect(states).toHaveLength(1);
    const state = states[0];
    expect(state?.journeyId).toBe(blueprintId);
    expect(state?.status).toBe("completed");
    expect(state?.hatchetRunId).toBe(wfr);
    const context = state?.context as Record<string, unknown>;
    expect(context.__blueprintVersion).toBe(1);
    expect(context.activated).toBe(false);
    // The decision verdict was recorded once (ctx.once) under the node id.
    expect(
      (context.__once__ as Record<string, unknown>)["decision:check-activated"],
    ).toBe(false);

    // The decision took the conditional-false edge → exactly ONE provider
    // send, keyed by the SAME auto-derivation code journeys get: the
    // replay-stable run anchor + the node id as the site + the template.
    expect(providerSends).toHaveLength(1);
    const sends = await db
      .select()
      .from(emailSends)
      .where(eq(emailSends.userId, userId));
    expect(sends).toHaveLength(1);
    expect(sends[0]?.templateKey).toBe("welcome");
    expect(sends[0]?.idempotencyKey).toBe(
      `journeySend:${wfr}:send-nudge:welcome`,
    );
  });

  it("takes the conditional-true edge (no send) when the decision passes", async () => {
    const blueprintId = `${RUN}-bp-true`;
    const userId = `${RUN}-true`;
    await insertBlueprint({ id: blueprintId, graph: nudgeGraph(blueprintId) });

    const result = (await interpreterFn()(
      input(userId, { blueprintId, properties: { activated: true } }),
      makeHatchetCtx(`${RUN}-wfr-true`),
    )) as { status: string };

    expect(result.status).toBe("completed");
    expect(providerSends).toHaveLength(0);
    const sends = await db
      .select({ id: emailSends.id })
      .from(emailSends)
      .where(eq(emailSends.userId, userId));
    expect(sends).toHaveLength(0);
  });

  it("replay of the SAME run id is exactly-once: one enrollment, one provider call, one email_sends row", async () => {
    const blueprintId = `${RUN}-bp-replay`;
    const userId = `${RUN}-replay`;
    await insertBlueprint({
      id: blueprintId,
      graph: sendOnlyGraph(blueprintId),
    });

    const ctx = makeHatchetCtx(`${RUN}-wfr-replay`);
    // ORIGINAL run, then a REPLAY-FROM-TOP of the same logical run (crash /
    // redeploy): the recovery-by-run-id path reuses the enrollment and the
    // node-id-derived send key collides on the email_sends unique index.
    await interpreterFn()(input(userId, { blueprintId }), ctx);
    await interpreterFn()(input(userId, { blueprintId }), ctx);

    expect(providerSends).toHaveLength(1);
    const states = await db
      .select({ id: journeyStates.id })
      .from(journeyStates)
      .where(eq(journeyStates.userId, userId));
    expect(states).toHaveLength(1);
    const sends = await db
      .select({ id: emailSends.id })
      .from(emailSends)
      .where(eq(emailSends.userId, userId));
    expect(sends).toHaveLength(1);
  });

  it("runs the SAME enrollment guards defineJourney runs: disabled + entryLimit once", async () => {
    // status !== "enabled" is the blueprint's meta.enabled === false.
    const disabledId = `${RUN}-bp-disabled`;
    await insertBlueprint({
      id: disabledId,
      graph: sendOnlyGraph(disabledId),
      status: "disabled",
    });
    const skipped = (await interpreterFn()(
      input(`${RUN}-disabled`, { blueprintId: disabledId }),
      makeHatchetCtx(`${RUN}-wfr-disabled`),
    )) as { status: string; reason: string };
    expect(skipped).toEqual({ status: "skipped", reason: "journey_disabled" });

    // entryLimit "once": a second, genuinely NEW run (distinct run id) skips
    // via the same checkEntryLimit code journeys use.
    const onceId = `${RUN}-bp-once`;
    const onceUser = `${RUN}-once`;
    await insertBlueprint({
      id: onceId,
      graph: sendOnlyGraph(onceId),
      entryLimit: "once",
    });
    const first = (await interpreterFn()(
      input(onceUser, { blueprintId: onceId }),
      makeHatchetCtx(`${RUN}-wfr-once-1`),
    )) as { status: string };
    expect(first.status).toBe("completed");
    const second = (await interpreterFn()(
      input(onceUser, { blueprintId: onceId }),
      makeHatchetCtx(`${RUN}-wfr-once-2`),
    )) as { status: string; reason: string };
    expect(second).toEqual({
      status: "skipped",
      reason: "already_entered_once",
    });
    expect(providerSends).toHaveLength(1);
  });

  it("throws at the trigger node when a legacy row forges a reserved-namespace event", async () => {
    // Rows saved BEFORE the save-time reserved-namespace rule (or written
    // out-of-band) still pass core's validateBlueprintGraph — the walk itself
    // must refuse to push an engine-emitted event through ctx.trigger.
    const badId = `${RUN}-bp-reserved`;
    const userId = `${RUN}-reserved`;
    await insertBlueprint({
      id: badId,
      graph: {
        journeyId: badId,
        nodes: [
          { id: "start", type: "start", title: "enroll" },
          {
            id: "fire-reserved",
            type: "trigger",
            title: "Forge engine event",
            meta: { event: "journey:completed" },
          },
          { id: "end-ok", type: "end-completed", title: "Done" },
        ],
        edges: [
          { id: "e1", source: "start", target: "fire-reserved" },
          { id: "e2", source: "fire-reserved", target: "end-ok" },
        ],
      },
    });

    await expect(
      interpreterFn()(
        input(userId, { blueprintId: badId }),
        makeHatchetCtx(`${RUN}-wfr-reserved`),
      ),
    ).rejects.toThrow(/reserved namespace/);

    // The run failed AT the trigger node with the structured error shape.
    const [state] = await db
      .select()
      .from(journeyStates)
      .where(eq(journeyStates.userId, userId));
    expect(state?.status).toBe("failed");
    const err = JSON.parse(state?.errorMessage ?? "{}");
    expect(err.nodeId).toBe("fire-reserved");
    expect(err.message).toContain("reserved namespace");
  });

  it("re-validates the stored graph at execution time (defense-in-depth) and skips unknown blueprints", async () => {
    // A digest node is display-tier-only: validateBlueprintGraph rejects it,
    // so a jsonb graph that bypassed save-time validation must NOT execute.
    const badId = `${RUN}-bp-bad`;
    await insertBlueprint({
      id: badId,
      graph: {
        journeyId: badId,
        nodes: [
          { id: "start", type: "start", title: "enroll" },
          { id: "digest-1", type: "digest", title: "Digest" },
        ],
        edges: [{ id: "e1", source: "start", target: "digest-1" }],
      },
    });
    const invalid = (await interpreterFn()(
      input(`${RUN}-bad`, { blueprintId: badId }),
      makeHatchetCtx(`${RUN}-wfr-bad`),
    )) as { status: string; reason: string };
    expect(invalid).toEqual({
      status: "skipped",
      reason: "invalid_blueprint_graph",
    });

    const missing = (await interpreterFn()(
      input(`${RUN}-missing`, { blueprintId: `${RUN}-bp-nope` }),
      makeHatchetCtx(`${RUN}-wfr-missing`),
    )) as { status: string; reason: string };
    expect(missing).toEqual({
      status: "skipped",
      reason: "blueprint_not_found",
    });

    const states = await db
      .select({ id: journeyStates.id })
      .from(journeyStates)
      .where(like(journeyStates.userId, `${RUN}-bad%`));
    expect(states).toHaveLength(0);
  });
});

describe("blueprint dispatch + exits through the ingest pipeline", () => {
  function stubHatchet() {
    return {
      events: { push: vi.fn(async (..._args: unknown[]) => {}) },
      runs: { cancel: vi.fn(async (..._args: unknown[]) => {}) },
    };
  }
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    // biome-ignore lint/suspicious/noExplicitAny: minimal logger stub
  } as any;

  it("ingestEvent pushes blueprint:run for enabled matching blueprints, honoring triggerWhere; drafts never fire", async () => {
    const proId = `${RUN}-bp-pro`;
    const draftId = `${RUN}-bp-draft`;
    await insertBlueprint({
      id: proId,
      graph: sendOnlyGraph(proId),
      triggerEvent: `${RUN}.signup`,
      triggerWhere: [
        { type: "property", property: "plan", operator: "eq", value: "pro" },
      ],
    });
    await insertBlueprint({
      id: draftId,
      graph: sendOnlyGraph(draftId),
      triggerEvent: `${RUN}.signup`,
      status: "draft",
    });

    const hatchet = stubHatchet();
    await ingestEvent({
      db,
      registry: new JourneyRegistry(),
      // biome-ignore lint/suspicious/noExplicitAny: stub hatchet client
      hatchet: hatchet as any,
      logger,
      event: {
        event: `${RUN}.signup`,
        userId: `${RUN}-dispatch`,
        userEmail: `${RUN}-dispatch@example.com`,
        eventProperties: { plan: "pro" },
      },
    });

    const blueprintPushes = hatchet.events.push.mock.calls.filter(
      ([name]) => name === BLUEPRINT_RUN_EVENT,
    );
    expect(blueprintPushes).toHaveLength(1);
    expect(blueprintPushes[0]?.[1]).toEqual({
      blueprintId: proId,
      blueprintVersion: 1,
      userId: `${RUN}-dispatch`,
      userEmail: `${RUN}-dispatch@example.com`,
      triggerProperties: { plan: "pro" },
    });

    // A non-matching triggerWhere dispatches nothing.
    const hatchet2 = stubHatchet();
    await ingestEvent({
      db,
      registry: new JourneyRegistry(),
      // biome-ignore lint/suspicious/noExplicitAny: stub hatchet client
      hatchet: hatchet2 as any,
      logger,
      event: {
        event: `${RUN}.signup`,
        userId: `${RUN}-dispatch`,
        userEmail: `${RUN}-dispatch@example.com`,
        eventProperties: { plan: "free" },
      },
    });
    expect(
      hatchet2.events.push.mock.calls.filter(
        ([name]) => name === BLUEPRINT_RUN_EVENT,
      ),
    ).toHaveLength(0);
  });

  it("honors a blueprint's exitOn: an active enrollment exits (and its run is cancelled) when the exit event ingests", async () => {
    const exitBpId = `${RUN}-bp-exit`;
    const userId = `${RUN}-exit`;
    await insertBlueprint({
      id: exitBpId,
      graph: sendOnlyGraph(exitBpId),
      triggerEvent: `${RUN}.exit-enroll`,
      exitOn: [{ event: `${RUN}.churned` }],
    });
    // Seed an in-flight enrollment as the interpreter would have created it.
    await db.insert(journeyStates).values({
      userId,
      userEmail: `${userId}@example.com`,
      journeyId: exitBpId,
      currentNodeId: "sleep-3d",
      status: "waiting",
      context: { __blueprintVersion: 1 },
      hatchetRunId: `${RUN}-wfr-exit`,
    });

    const hatchet = stubHatchet();
    await ingestEvent({
      db,
      registry: new JourneyRegistry(),
      // biome-ignore lint/suspicious/noExplicitAny: stub hatchet client
      hatchet: hatchet as any,
      logger,
      event: {
        event: `${RUN}.churned`,
        userId,
        userEmail: `${userId}@example.com`,
        eventProperties: {},
      },
    });

    const [state] = await db
      .select({ status: journeyStates.status })
      .from(journeyStates)
      .where(eq(journeyStates.userId, userId));
    expect(state?.status).toBe("exited");
    expect(hatchet.runs.cancel).toHaveBeenCalledWith({
      ids: [`${RUN}-wfr-exit`],
    });
  });
});
