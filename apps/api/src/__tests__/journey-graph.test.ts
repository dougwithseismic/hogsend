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
    expect(types(graph)).toEqual([
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
    expect(ids(graph)).toEqual([
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

  it("labels the if-guarded reminder + trigger edges conditional-true (Tier 2)", () => {
    const reminderEdge = graph.edges.find(
      (e) => e.target === "send:nps-reminder",
    );
    expect(reminderEdge?.kind).toBe("conditional-true");
    expect(reminderEdge?.label).toContain("timedOut");

    const triggerEdge = graph.edges.find(
      (e) => e.target === "trigger:NPS_DETRACTOR",
    );
    expect(triggerEdge?.kind).toBe("conditional-true");
  });

  it("connects a single end-completed terminal from the last node", () => {
    const last = graph.edges.at(-1);
    expect(last?.source).toBe("trigger:NPS_DETRACTOR");
    expect(last?.target).toBe("end-completed");
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
    expect(types(graph)).toEqual([
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
    expect(ids(graph)).toEqual([
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

  it("marks the two if-guarded sends conditional-true, final send default", () => {
    const guarded = graph.edges.find((e) => e.target === "send:initial-nudge");
    expect(guarded?.kind).toBe("conditional-true");
    const guarded2 = graph.edges.find((e) => e.target === "send:setup-check");
    expect(guarded2?.kind).toBe("conditional-true");
    const finalSend = graph.edges.find((e) => e.target === "send:community");
    expect(finalSend?.kind).toBe("default");
  });
});

describe("buildJourneyGraph — connector-only + helper (unused _ctx)", () => {
  const meta = metaFor({ id: "discord-lifecycle" });
  // `_ctx` is present but unused; a direct sendConnectorAction (→ connector) plus
  // an awaited bare helper (→ unknown + warning).
  const runSource = `async (user, _ctx) => {
    if (source === "discord") {
      await sendConnectorAction({
        connectorId: "discord",
        action: "dmMember",
        args: { member: user.id, content: "hi" },
      });
    }
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
