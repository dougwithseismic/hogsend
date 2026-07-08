import {
  buildJourneyGraph,
  days,
  degradedGraphFromMeta,
  type JourneyGraph,
  type JourneyMeta,
  journeyGraphSchema,
} from "@hogsend/engine";
import { describe, expect, it } from "vitest";

// Phase 1 — the runtime AST extractor. Two layers of coverage:
//
// 1. Parser UNITS over representative `run` source STRINGS (hermetic — no DB,
//    no worker, no hatchet). The strings mirror the shape of the real journeys
//    so we assert node types, ids, source order, and the key meta fields the
//    Studio join-key + visual depend on (duration, idempotencyLabel, unstable).
// 2. One REAL-IMPORT smoke: import an actual journey and prove its captured
//    `runSource` round-trips through the extractor.
//
// INVARIANT for every graph the extractor returns (degraded or not): it must
// satisfy `journeyGraphSchema`.

/** Minimal helper to build a valid `JourneyMeta` for the hermetic string tests. */
function metaFor(overrides: Partial<JourneyMeta> = {}): JourneyMeta {
  return {
    id: "test-journey",
    name: "Test Journey",
    enabled: true,
    trigger: { event: "user.created" },
    entryLimit: "once",
    suppress: days(1),
    ...overrides,
  };
}

const ids = (g: JourneyGraph) => g.nodes.map((n) => n.id);
const types = (g: JourneyGraph) => g.nodes.map((n) => n.type);
const nodeById = (g: JourneyGraph, id: string) =>
  g.nodes.find((n) => n.id === id);

function expectValidGraph(g: JourneyGraph): void {
  const parsed = journeyGraphSchema.safeParse(g);
  expect(parsed.success).toBe(true);
}

describe("buildJourneyGraph — feedback-nps shape", () => {
  const meta = metaFor({
    id: "feedback-nps",
    name: "Feedback — NPS Survey",
    trigger: { event: "user.created" },
    exitOn: [{ event: "user.deleted" }],
  });
  // sleep(label+duration) → send(idempotencyLabel) → waitForEvent →
  // if(timedOut){ send(idempotencyLabel) → waitForEvent } → checkpoint(template)
  // → capture → if(score<=6){ trigger }
  const runSource = `async (user, ctx) => {
    await ctx.sleep({ duration: days(14), label: "day-14" });
    await sendEmail({
      to: user.email,
      template: Templates.FEEDBACK_NPS_SURVEY,
      idempotencyLabel: "nps-survey",
    });
    let answer = await ctx.waitForEvent({
      event: Events.NPS_SUBMITTED,
      timeout: days(3),
      label: "await-score",
    });
    if (answer.timedOut) {
      await sendEmail({
        to: user.email,
        template: Templates.FEEDBACK_NPS_SURVEY,
        idempotencyLabel: "nps-reminder",
      });
      answer = await ctx.waitForEvent({
        event: Events.NPS_SUBMITTED,
        timeout: days(7),
        label: "await-score-reminder",
      });
    }
    if (answer.timedOut) return;
    await ctx.checkpoint(\`scored-\${score}\`);
    getPostHog()?.identify(user.id, { nps_score: score });
    if (score <= 6) {
      await ctx.trigger({
        event: Events.NPS_DETRACTOR,
        userId: user.id,
        properties: { score },
      });
    }
  }`;

  const graph = buildJourneyGraph({ runSource, meta });

  it("is a valid, non-degraded graph", () => {
    expectValidGraph(graph);
    expect(graph.degraded).toBeUndefined();
    expect(graph.journeyId).toBe("feedback-nps");
  });

  it("emits nodes in source order with the expected types", () => {
    // Filter decision nodes (control-flow synthetic) — this asserts the
    // call-derived node backbone in source order.
    expect(types(graph).filter((t) => t !== "decision")).toEqual([
      "start",
      "sleep",
      "send",
      "wait",
      "send",
      "wait",
      "checkpoint",
      "capture",
      "trigger",
      "end-completed",
    ]);
  });

  it("keys nodes on authored labels / idempotency sites (A2 join key)", () => {
    expect(ids(graph).filter((id) => !id.startsWith("decision:"))).toEqual([
      "start",
      "day-14",
      "send:nps-survey",
      "await-score",
      "send:nps-reminder",
      "await-score-reminder",
      "scored-${…}",
      "capture:6",
      "trigger:NPS_DETRACTOR",
      "end-completed",
    ]);
  });

  it("extracts duration + timeout as REAL DurationObjects (days() = hours)", () => {
    // `days(n)`/`hours(n)` reconstruct the actual `@hogsend/core` object
    // (days(14) = { hours: 336 }) so an unlabeled node's synthetic id matches
    // the engine's runtime currentNodeId byte-for-byte.
    expect(nodeById(graph, "day-14")?.meta?.duration).toEqual({ hours: 336 });
    expect(nodeById(graph, "await-score")?.meta?.timeout).toEqual({
      hours: 72,
    });
    expect(nodeById(graph, "await-score-reminder")?.meta?.timeout).toEqual({
      hours: 168,
    });
    // Display stays human-friendly.
    expect(nodeById(graph, "day-14")?.subtitle).toBe("14 days");
  });

  it("records idempotencyLabel on send nodes", () => {
    expect(nodeById(graph, "send:nps-survey")?.meta?.idempotencyLabel).toBe(
      "nps-survey",
    );
    expect(nodeById(graph, "send:nps-reminder")?.meta?.idempotencyLabel).toBe(
      "nps-reminder",
    );
  });

  it("marks the template-literal checkpoint id unstable", () => {
    expect(nodeById(graph, "scored-${…}")?.meta?.unstable).toBe(true);
  });

  it("puts trigger.where on start and exitOn in warnings", () => {
    // no where here, but exitOn should surface as a warning
    expect(graph.warnings).toContain("exits on: user.deleted");
    expect(nodeById(graph, "start")?.subtitle).toBe("user.created");
  });

  it("FORKS the first waitForEvent into timedOut + answered, converging", () => {
    // The first wait (`await-score`) is a real fork: the timed-out branch runs
    // the reminder send, the answered branch skips straight to the continuation;
    // both converge at the checkpoint (`scored-${…}`).
    const outOfWait = graph.edges.filter((e) => e.source === "await-score");
    const timedOut = outOfWait.find((e) => e.kind === "timedOut");
    const answered = outOfWait.find((e) => e.kind === "answered");

    // timedOut → the reminder-send path (reminder is on the timedOut branch).
    expect(timedOut?.target).toBe("send:nps-reminder");
    // answered → the continuation (the checkpoint), NOT a step after the reminder.
    expect(answered?.target).toBe("scored-${…}");

    // Convergence: the timedOut path (…→ await-score-reminder) and the answered
    // path both reach the checkpoint.
    const intoCheckpoint = graph.edges
      .filter((e) => e.target === "scored-${…}")
      .map((e) => e.source);
    expect(intoCheckpoint).toContain("await-score-reminder"); // timedOut path
    expect(intoCheckpoint).toContain("await-score"); // answered path
  });

  it("routes score<=6 through a humanized DECISION node (`Score ≤ 6?`)", () => {
    // `capture` flows into a decision node; yes → trigger, no → end.
    const trigger = graph.edges.find(
      (e) => e.target === "trigger:NPS_DETRACTOR",
    );
    const decisionId = trigger?.source;
    expect(decisionId).toMatch(/^decision:/);
    expect(trigger?.kind).toBe("conditional-true");
    expect(trigger?.label).toBe("yes");

    const decision = nodeById(graph, decisionId ?? "");
    expect(decision?.type).toBe("decision");
    expect(decision?.title).toBe("Score ≤ 6?");

    // capture → decision, and the decision's `no` edge terminates.
    expect(
      graph.edges.some(
        (e) => e.source === "capture:6" && e.target === decisionId,
      ),
    ).toBe(true);
    expect(
      graph.edges.some(
        (e) =>
          e.source === decisionId &&
          e.target === "end-completed" &&
          e.kind === "conditional-false",
      ),
    ).toBe(true);
    // The trigger path also terminates.
    expect(
      graph.edges.some(
        (e) =>
          e.source === "trigger:NPS_DETRACTOR" && e.target === "end-completed",
      ),
    ).toBe(true);
  });
});

describe("buildJourneyGraph — activation-nudge shape", () => {
  const meta = metaFor({ id: "activation-nudge-series" });
  // Multiple ctx.sleep + if-guarded sends + a final UNCONDITIONAL send. Templates
  // are non-literal member expressions (Templates.X) so the typed `template`
  // stays undefined but the node is still labeled by the nearest sleep label.
  const runSource = `async (user, ctx) => {
    await ctx.sleep({ duration: days(2), label: "initial-nudge" });
    const { found: hasUsedFeature } = await ctx.history.hasEvent({
      userId: user.id,
      event: Events.FEATURE_USED,
      within: days(2),
    });
    if (!hasUsedFeature) {
      await sendEmail({ to: user.email, template: Templates.ACTIVATION_NUDGE_SERIES });
    }
    await ctx.sleep({ duration: days(1), label: "setup-check" });
    const { found: hasCompletedSetup } = await ctx.history.hasEvent({
      userId: user.id,
      event: Events.SETUP_COMPLETED,
      within: days(3),
    });
    if (!hasCompletedSetup) {
      await sendEmail({ to: user.email, template: Templates.ACTIVATION_QUICKSTART });
    }
    await ctx.sleep({ duration: days(2), label: "community" });
    await sendEmail({ to: user.email, template: Templates.ACTIVATION_COMMUNITY_ALT });
  }`;

  const graph = buildJourneyGraph({ runSource, meta });

  it("is valid and non-degraded", () => {
    expectValidGraph(graph);
    expect(graph.degraded).toBeUndefined();
  });

  it("emits 3 sleeps + 3 sends in order, no ctx.history nodes", () => {
    expect(types(graph).filter((t) => t !== "decision")).toEqual([
      "start",
      "sleep",
      "send",
      "sleep",
      "send",
      "sleep",
      "send",
      "end-completed",
    ]);
  });

  it("derives each send id from its nearest preceding sleep label", () => {
    expect(ids(graph).filter((id) => !id.startsWith("decision:"))).toEqual([
      "start",
      "initial-nudge",
      "send:initial-nudge",
      "setup-check",
      "send:setup-check",
      "community",
      "send:community",
      "end-completed",
    ]);
  });

  it("leaves the typed template undefined for member-expr templates but labels via subtitle", () => {
    const firstSend = nodeById(graph, "send:initial-nudge");
    expect(firstSend?.meta?.template).toBeUndefined();
    expect(firstSend?.subtitle).toBe("ACTIVATION_NUDGE_SERIES");
  });

  it("routes each guarded send through a humanized DECISION node (no→send, yes→bypass)", () => {
    // The test is negated (`if (!hasUsedFeature)`), so the POSITIVE-question title
    // "Feature used?" routes the send onto the `no` edge (feature NOT used → send
    // the nudge) and the bypass onto `yes`. Both converge at the next sleep.
    const toNudge = graph.edges.find((e) => e.target === "send:initial-nudge");
    const d0 = toNudge?.source;
    expect(d0).toMatch(/^decision:/);
    expect(toNudge?.kind).toBe("conditional-false"); // no → send
    expect(toNudge?.label).toBe("no");
    expect(nodeById(graph, d0 ?? "")?.title).toMatch(/feature/i);

    // sleep flows into the decision; the `yes` edge bypasses to the next sleep.
    expect(
      graph.edges.some((e) => e.source === "initial-nudge" && e.target === d0),
    ).toBe(true);
    const intoSetup = graph.edges
      .filter((e) => e.target === "setup-check")
      .map((e) => `${e.source}:${e.kind}`);
    expect(intoSetup).toContain("send:initial-nudge:default"); // sent → continue
    expect(intoSetup).toContain(`${d0}:conditional-true`); // yes → bypass

    // Second guarded send, same shape (humanized "Setup completed?").
    const toQuickstart = graph.edges.find(
      (e) => e.target === "send:setup-check",
    );
    const d1 = toQuickstart?.source;
    expect(toQuickstart?.kind).toBe("conditional-false"); // no → send
    expect(nodeById(graph, d1 ?? "")?.title).toBe("Setup completed?");
    const intoCommunity = graph.edges
      .filter((e) => e.target === "community")
      .map((e) => `${e.source}:${e.kind}`);
    expect(intoCommunity).toContain("send:setup-check:default");
    expect(intoCommunity).toContain(`${d1}:conditional-true`); // yes → bypass

    // The final send is unconditional (on the main line, no decision).
    expect(graph.edges.find((e) => e.target === "send:community")?.kind).toBe(
      "default",
    );
  });
});

describe("buildJourneyGraph — test-onboarding decision node + convergence", () => {
  const meta = metaFor({ id: "test-onboarding" });
  // The canonical case the linear backbone got WRONG. Now the if/else becomes an
  // explicit DECISION node with a HUMANIZED question (traced from the `isPro`
  // binding → `user.properties.plan === "pro"`), whose yes/no edges enter the two
  // branches, both converging into `completed`. Mirrors the real journey.
  const runSource = `async (user, ctx) => {
    await ctx.trigger({ event: Events.WELCOME, userId: user.id });
    const isPro = user.properties.plan === "pro";
    if (isPro) {
      await ctx.trigger({ event: Events.PRO_PATH, userId: user.id });
    } else {
      await ctx.trigger({ event: Events.FREE_PATH, userId: user.id });
    }
    await ctx.trigger({ event: Events.COMPLETED, userId: user.id });
  }`;

  const graph = buildJourneyGraph({ runSource, meta });

  it("is valid and non-degraded", () => {
    expectValidGraph(graph);
    expect(graph.degraded).toBeUndefined();
  });

  it("emits a humanized DECISION node titled `Plan is pro?`", () => {
    const decision = graph.nodes.find((n) => n.type === "decision");
    expect(decision?.title).toBe("Plan is pro?");
    expect(decision?.meta?.unstable).toBe(true);
    expect(decision?.id).toMatch(/^decision:/);
  });

  it("routes welcome → decision → {yes: PRO_PATH, no: FREE_PATH}", () => {
    const decisionId = graph.nodes.find((n) => n.type === "decision")?.id;

    // welcome flows into the decision (not directly to a branch).
    expect(
      graph.edges.some(
        (e) => e.source === "trigger:WELCOME" && e.target === decisionId,
      ),
    ).toBe(true);

    const outOfDecision = graph.edges.filter((e) => e.source === decisionId);
    expect(outOfDecision).toHaveLength(2);
    const toPro = outOfDecision.find((e) => e.target === "trigger:PRO_PATH");
    const toFree = outOfDecision.find((e) => e.target === "trigger:FREE_PATH");
    expect(toPro?.kind).toBe("conditional-true");
    expect(toPro?.label).toBe("yes");
    expect(toFree?.kind).toBe("conditional-false");
    expect(toFree?.label).toBe("no");
  });

  it("converges BOTH branches into `completed` with default edges", () => {
    const intoCompleted = graph.edges.filter(
      (e) => e.target === "trigger:COMPLETED",
    );
    expect(intoCompleted.map((e) => e.source).sort()).toEqual([
      "trigger:FREE_PATH",
      "trigger:PRO_PATH",
    ]);
    for (const e of intoCompleted) expect(e.kind).toBe("default");

    // FREE_PATH must NOT be a step after PRO_PATH (the old linear bug).
    expect(
      graph.edges.some(
        (e) =>
          e.source === "trigger:PRO_PATH" && e.target === "trigger:FREE_PATH",
      ),
    ).toBe(false);

    // …and completion flows from the convergence point.
    expect(
      graph.edges.some(
        (e) => e.source === "trigger:COMPLETED" && e.target === "end-completed",
      ),
    ).toBe(true);
  });
});

describe("buildJourneyGraph — connector-only + helper (unused _ctx)", () => {
  const meta = metaFor({ id: "discord-lifecycle" });
  // `_ctx` is present but unused; a direct sendConnectorAction (→ connector) plus
  // an awaited bare helper (→ unknown + warning). No `if`, so no decision node —
  // this test isolates connector + unknown detection.
  const runSource = `async (user, _ctx) => {
    await sendConnectorAction({
      connectorId: "discord",
      action: "dmMember",
      args: { member: user.id, content: "hi" },
    });
    await grantAndAnnounce({ member: user.id, roleId: "x", dm: "welcome" });
  }`;

  const graph = buildJourneyGraph({ runSource, meta });

  it("is valid and non-degraded", () => {
    expectValidGraph(graph);
    expect(graph.degraded).toBeUndefined();
  });

  it("emits a connector node keyed by connectorId:action and an unknown node", () => {
    expect(types(graph)).toEqual([
      "start",
      "connector",
      "unknown",
      "end-completed",
    ]);
    expect(ids(graph)).toEqual([
      "start",
      "connector:discord:dmMember",
      "unknown:grantAndAnnounce:1",
      "end-completed",
    ]);
  });

  it("records connectorId + action on the connector node", () => {
    const c = nodeById(graph, "connector:discord:dmMember");
    expect(c?.meta?.connectorId).toBe("discord");
    expect(c?.meta?.action).toBe("dmMember");
  });

  it("warns that the helper call's side effects are not expanded", () => {
    expect(graph.warnings).toContain(
      "'grantAndAnnounce' is a helper call — its side effects are not expanded",
    );
  });
});

describe("buildJourneyGraph — degraded fallbacks (never throws)", () => {
  const meta = metaFor({ id: "garbage-journey" });

  it("falls back to a degraded graph on unparseable source", () => {
    const graph = buildJourneyGraph({
      runSource: "this is not <<< valid javascript ((",
      meta,
    });
    expectValidGraph(graph);
    expect(graph.degraded).toBe(true);
    expect(types(graph)).toEqual(["start", "end-completed"]);
    expect(graph.warnings).toEqual([
      "journey source unavailable — showing trigger only",
    ]);
  });

  it("falls back to a degraded graph when runSource is missing", () => {
    const graph = buildJourneyGraph({ runSource: undefined, meta });
    expectValidGraph(graph);
    expect(graph.degraded).toBe(true);
    expect(ids(graph)).toEqual(["start", "end-completed"]);
  });

  it("degradedGraphFromMeta carries trigger.where onto the start node", () => {
    const withWhere = metaFor({
      id: "conditional-journey",
      trigger: {
        event: "signup",
        where: [
          { type: "property", property: "plan", operator: "eq", value: "pro" },
        ],
      },
    });
    const graph = degradedGraphFromMeta(withWhere);
    expectValidGraph(graph);
    expect(graph.degraded).toBe(true);
    expect(nodeById(graph, "start")?.meta?.conditions).toHaveLength(1);
  });
});

describe("buildJourneyGraph — trigger.where chips on start", () => {
  it("puts a builder-normalized where onto the start node", () => {
    const meta = metaFor({
      trigger: {
        event: "nps.scored",
        where: [
          { type: "property", property: "score", operator: "lte", value: 6 },
        ],
      },
    });
    const graph = buildJourneyGraph({
      runSource: `async (user, ctx) => { await ctx.checkpoint("done"); }`,
      meta,
    });
    expectValidGraph(graph);
    const start = nodeById(graph, "start");
    expect(start?.subtitle).toBe("nps.scored");
    expect(start?.meta?.conditions).toEqual([
      { type: "property", property: "score", operator: "lte", value: 6 },
    ]);
  });
});

describe("buildJourneyGraph — A2 join-key fidelity (mirror the runtime)", () => {
  const meta = metaFor();

  it("keys an UNLABELED sleep on the REAL duration object (matches currentNodeId)", () => {
    // Engine writes currentNodeId = `wait:${JSON.stringify(duration)}` with the
    // real object; days(14) = { hours: 336 }, so the id must be that exactly.
    const graph = buildJourneyGraph({
      runSource: `async (user, ctx) => { await ctx.sleep({ duration: days(14) }); }`,
      meta,
    });
    expectValidGraph(graph);
    const sleep = graph.nodes.find((n) => n.type === "sleep");
    expect(sleep?.id).toBe('wait:{"hours":336}');
    expect(sleep?.meta?.duration).toEqual({ hours: 336 });
    expect(sleep?.subtitle).toBe("14 days");
  });

  it("propagates a deterministic synthetic SLEEP label to a label-less send site", () => {
    // The engine's boundary.currentLabel advances even for default labels, so a
    // following label-less send inherits `wait:{"hours":48}` as its site.
    const graph = buildJourneyGraph({
      runSource: `async (user, ctx) => {
        await ctx.sleep({ duration: days(2) });
        await sendEmail({ to: user.email, template: Templates.X });
      }`,
      meta,
    });
    expectValidGraph(graph);
    expect(graph.nodes.find((n) => n.type === "send")?.id).toBe(
      'send:wait:{"hours":48}',
    );
  });

  it("propagates a deterministic synthetic WAIT-EVENT label to a label-less send site", () => {
    const graph = buildJourneyGraph({
      runSource: `async (user, ctx) => {
        await ctx.waitForEvent({ event: "foo", timeout: hours(1) });
        await sendEmail({ to: user.email, template: Templates.X });
      }`,
      meta,
    });
    expectValidGraph(graph);
    expect(graph.nodes.find((n) => n.type === "send")?.id).toBe(
      "send:wait-event:foo",
    );
  });

  it("treats an OPTIONAL awaited helper call the same as a plain one", () => {
    // `await helper?.()` nests a ChainExpression — the awaited check must still
    // fire so the side effect is not silently dropped.
    const graph = buildJourneyGraph({
      runSource: `async (user, ctx) => { await maybeNudge?.(user); }`,
      meta,
    });
    expectValidGraph(graph);
    expect(types(graph)).toEqual(["start", "unknown", "end-completed"]);
    expect(nodeById(graph, "unknown:maybeNudge:0")).toBeDefined();
    expect(graph.warnings).toContain(
      "'maybeNudge' is a helper call — its side effects are not expanded",
    );
  });
});

// --- Real-import smoke: an actual journey's captured source round-trips. ---
describe("buildJourneyGraph — real journey import smoke", () => {
  it("extracts a graph from the live feedbackNps.runSource", async () => {
    const { feedbackNps } = await import("../journeys/feedback-nps.js");
    expect(typeof feedbackNps.runSource).toBe("string");
    expect(
      feedbackNps.runSource && feedbackNps.runSource.length,
    ).toBeGreaterThan(0);

    const graph = buildJourneyGraph({
      runSource: feedbackNps.runSource,
      meta: feedbackNps.meta,
    });
    expectValidGraph(graph);
    expect(graph.degraded).toBeUndefined();
    expect(nodeById(graph, "start")).toBeDefined();
    expect(nodeById(graph, "end-completed")).toBeDefined();
    expect(graph.nodes.some((n) => n.type === "send")).toBe(true);
    expect(graph.nodes.some((n) => n.type === "wait")).toBe(true);
  });
});
