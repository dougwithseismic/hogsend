import type { BlueprintGraph, ConditionEval } from "@hogsend/engine";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  type CodegenBlueprintInput,
  compileCondition,
  generateJourneyFile,
} from "../lib/blueprint-codegen.js";

/**
 * Unit tests for the blueprint → defineJourney() codegen. Pure string
 * generation — no DB, no filesystem. Every generated file is additionally
 * fed through the TypeScript compiler (`ts.transpileModule` with
 * `reportDiagnostics`) as a syntax gate: the output must be valid TS even
 * when it carries TODO stubs.
 */

/** Fail the test if `source` is not syntactically valid TypeScript. */
function expectValidTs(source: string): void {
  const result = ts.transpileModule(source, {
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const errors = (result.diagnostics ?? []).map((diagnostic) =>
    ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
  );
  expect(errors).toEqual([]);
}

function makeBlueprint(
  graph: BlueprintGraph,
  overrides: Partial<CodegenBlueprintInput> = {},
): CodegenBlueprintInput {
  return {
    id: graph.journeyId,
    name: "Synthetic blueprint",
    description: null,
    triggerEvent: "demo.trigger",
    triggerWhere: null,
    entryLimit: "unlimited",
    entryPeriod: null,
    exitOn: null,
    suppress: {},
    graph,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. The real seed example blueprint (activation-nudge-blueprint) — graph and
// row fields verbatim from
// packages/create-hogsend/template/scripts/seed-example-blueprint.ts
// ---------------------------------------------------------------------------

const seedGraph: BlueprintGraph = {
  journeyId: "activation-nudge-blueprint",
  nodes: [
    { id: "start", type: "start", title: "feature.activated" },
    {
      id: "sleep-2d",
      type: "sleep",
      title: "Wait 2 days",
      meta: { duration: { hours: 48 } },
    },
    {
      id: "check-used-again",
      type: "decision",
      title: "Used the feature again?",
      meta: {
        conditions: [
          { type: "event", eventName: "feature.used", check: "exists" },
        ],
      },
    },
    {
      id: "send-nudge",
      type: "send",
      title: "Send activation nudge",
      meta: { template: "activation/nudge" },
    },
    { id: "end-ok", type: "end-completed", title: "Done" },
  ],
  edges: [
    { id: "e1", source: "start", target: "sleep-2d" },
    { id: "e2", source: "sleep-2d", target: "check-used-again" },
    {
      id: "e3",
      source: "check-used-again",
      target: "end-ok",
      kind: "conditional-true",
    },
    {
      id: "e4",
      source: "check-used-again",
      target: "send-nudge",
      kind: "conditional-false",
    },
    { id: "e5", source: "send-nudge", target: "end-ok" },
  ],
};

const seedBlueprint: CodegenBlueprintInput = makeBlueprint(seedGraph, {
  name: "Activation nudge (example blueprint)",
  triggerEvent: "feature.activated",
  entryLimit: "once",
});

describe("generateJourneyFile — seed example blueprint", () => {
  const output = generateJourneyFile(seedBlueprint, {
    journeyId: "activation-nudge",
  });

  it("emits the durable sleep with the node id as label", () => {
    expect(output).toContain(
      'await ctx.sleep({ duration: { hours: 48 }, label: "sleep-2d" });',
    );
  });

  it("compiles the exists EventCondition into a ctx.once-wrapped ctx.history.hasEvent check", () => {
    // The verdict is recorded once (key `decision:<nodeId>`) so a replay can't
    // flip the branch; the compiled condition lives inside the once callback.
    expect(output).toContain(
      'const decisionCheckUsedAgain = await ctx.once("decision:check-used-again", async () => {',
    );
    expect(output).toContain(
      'return (await ctx.history.hasEvent({ userId: user.id, event: "feature.used" })).found;',
    );
    expect(output).toContain("if (decisionCheckUsedAgain) {");
  });

  it("sends the right template on the false branch, ends on the true branch", () => {
    expect(output).toContain('template: "activation/nudge",');
    expect(output).toContain("to: user.email,");
    expect(output).toContain("userId: user.id,");
    expect(output).toContain("journeyStateId: user.stateId,");
    expect(output).toContain("journeyName: user.journeyName,");
    // props threads the enrolling user's properties so the template renders
    // personalized (interpreter parity).
    expect(output).toContain("props: user.properties,");
    // conditional-true → end-completed: an empty branch, marked as such
    expect(output).toContain("// (the journey ends on this branch)");
  });

  it("labels an unlabelled send with its node id (mirrors the interpreter)", () => {
    // send-nudge carries no author idempotencyLabel → the node id is used, so
    // two sends of the same template on divergent branches never collide.
    expect(output).toContain('idempotencyLabel: "send-nudge",');
  });

  it("builds the meta object from the row fields", () => {
    expect(output).toContain('id: "activation-nudge",');
    expect(output).toContain('name: "Activation nudge (example blueprint)",');
    expect(output).toContain("enabled: true,");
    expect(output).toContain('trigger: { event: "feature.activated" },');
    expect(output).toContain('entryLimit: "once",');
    expect(output).toContain("suppress: {},");
    // null/absent row fields are omitted entirely
    expect(output).not.toContain("description:");
    expect(output).not.toContain("entryPeriod:");
    expect(output).not.toContain("exitOn:");
    expect(output).not.toContain("where:");
  });

  it("emits only the imports the body needs and a camelCase export", () => {
    expect(output).toContain(
      'import { defineJourney, sendEmail } from "@hogsend/engine";',
    );
    expect(output).not.toContain("sendConnectorAction");
    expect(output).toContain("export const activationNudge = defineJourney({");
  });

  it("is syntactically valid TypeScript", () => {
    expectValidTs(output);
  });
});

// ---------------------------------------------------------------------------
// 2. count-check EventCondition with an operator/value
// ---------------------------------------------------------------------------

describe("generateJourneyFile — count EventCondition", () => {
  const graph: BlueprintGraph = {
    journeyId: "count-demo",
    nodes: [
      { id: "start", type: "start", title: "demo.trigger" },
      {
        id: "check-count",
        type: "branch",
        title: "Used it at least 3 times?",
        meta: {
          conditions: [
            {
              type: "event",
              eventName: "feature.used",
              check: "count",
              operator: "gte",
              value: 3,
            },
          ],
        },
      },
      {
        id: "checkpoint-power-user",
        type: "checkpoint",
        title: "Power user",
      },
      { id: "end-a", type: "end-completed", title: "Done" },
      { id: "end-b", type: "end-completed", title: "Done" },
    ],
    edges: [
      { id: "e1", source: "start", target: "check-count" },
      {
        id: "e2",
        source: "check-count",
        target: "checkpoint-power-user",
        kind: "conditional-true",
      },
      {
        id: "e3",
        source: "check-count",
        target: "end-b",
        kind: "conditional-false",
      },
      { id: "e4", source: "checkpoint-power-user", target: "end-a" },
    ],
  };

  it("maps the operator to the right JS comparison", () => {
    const output = generateJourneyFile(makeBlueprint(graph), {
      journeyId: "count-demo",
    });
    expect(output).toContain(
      'const decisionCheckCount = await ctx.once("decision:check-count", async () => {',
    );
    expect(output).toContain(
      'return (await ctx.history.hasEvent({ userId: user.id, event: "feature.used" })).count >= 3;',
    );
    expect(output).toContain("if (decisionCheckCount) {");
    expect(output).toContain('await ctx.checkpoint("checkpoint-power-user");');
    expectValidTs(output);
  });
});

// ---------------------------------------------------------------------------
// 2b. wait node with divergent answered/timedOut edges
// ---------------------------------------------------------------------------

describe("generateJourneyFile — wait node forks", () => {
  const forkGraph: BlueprintGraph = {
    journeyId: "nps-demo",
    nodes: [
      { id: "start", type: "start", title: "nps.sent" },
      {
        id: "nps-wait",
        type: "wait",
        title: "Wait for the NPS answer",
        meta: { event: "nps.answered", timeout: { hours: 72 } },
      },
      {
        id: "send-reminder",
        type: "send",
        title: "Send reminder",
        meta: { template: "nps/reminder", idempotencyLabel: "nps-reminder" },
      },
      {
        id: "trigger-answered",
        type: "trigger",
        title: "Record the answer",
        meta: { event: "nps.recorded" },
      },
      { id: "end-a", type: "end-completed", title: "Done" },
      { id: "end-b", type: "end-completed", title: "Done" },
    ],
    edges: [
      { id: "e1", source: "start", target: "nps-wait" },
      {
        id: "e2",
        source: "nps-wait",
        target: "send-reminder",
        kind: "timedOut",
      },
      {
        id: "e3",
        source: "nps-wait",
        target: "trigger-answered",
        kind: "answered",
      },
      { id: "e4", source: "send-reminder", target: "end-a" },
      { id: "e5", source: "trigger-answered", target: "end-b" },
    ],
  };

  it("emits a .timedOut fork when answered/timedOut edges diverge", () => {
    const output = generateJourneyFile(makeBlueprint(forkGraph), {
      journeyId: "nps-demo",
    });
    expect(output).toContain("const npsWait = await ctx.waitForEvent({");
    expect(output).toContain('event: "nps.answered",');
    expect(output).toContain("timeout: { hours: 72 },");
    expect(output).toContain('label: "nps-wait",');
    expect(output).toContain("if (npsWait.timedOut) {");
    // timedOut branch → reminder send with its idempotencyLabel
    expect(output).toContain('idempotencyLabel: "nps-reminder",');
    // answered branch → the trigger, with userEmail + node-id label
    expect(output).toContain(
      'await ctx.trigger({ event: "nps.recorded", userId: user.id, userEmail: user.email, idempotencyLabel: "trigger-answered" });',
    );
    expectValidTs(output);
  });

  it("keeps a single-edge wait as a plain await, no variable, no fork", () => {
    const linearGraph: BlueprintGraph = {
      journeyId: "linear-wait",
      nodes: [
        { id: "start", type: "start", title: "demo.trigger" },
        {
          id: "wait-reply",
          type: "wait",
          title: "Wait for a reply",
          meta: { event: "demo.replied", timeout: { hours: 24 } },
        },
        { id: "checkpoint-after", type: "checkpoint", title: "After wait" },
        { id: "end", type: "end-completed", title: "Done" },
      ],
      edges: [
        { id: "e1", source: "start", target: "wait-reply" },
        { id: "e2", source: "wait-reply", target: "checkpoint-after" },
        { id: "e3", source: "checkpoint-after", target: "end" },
      ],
    };
    const output = generateJourneyFile(makeBlueprint(linearGraph), {
      journeyId: "linear-wait",
    });
    expect(output).toContain("await ctx.waitForEvent({");
    expect(output).not.toContain("const waitReply");
    expect(output).not.toContain(".timedOut");
    expectValidTs(output);
  });
});

// ---------------------------------------------------------------------------
// 2c. terminal nodes compile faithfully (end-completed / end-exited / end-failed)
// ---------------------------------------------------------------------------

describe("generateJourneyFile — terminal nodes", () => {
  // A wait fork routes one branch to end-exited and the other to end-failed,
  // and a single-edge wait ends at end-completed — so one graph exercises all
  // three terminals without a decision node.
  const terminalsGraph: BlueprintGraph = {
    journeyId: "terminals-demo",
    nodes: [
      { id: "start", type: "start", title: "demo.trigger" },
      {
        id: "await-reply",
        type: "wait",
        title: "Wait for a reply",
        meta: { event: "demo.replied", timeout: { hours: 24 } },
      },
      { id: "exit-here", type: "end-exited", title: "Bail out" },
      { id: "fail-here", type: "end-failed", title: "Hard fail" },
    ],
    edges: [
      { id: "e1", source: "start", target: "await-reply" },
      {
        id: "e2",
        source: "await-reply",
        target: "exit-here",
        kind: "answered",
      },
      {
        id: "e3",
        source: "await-reply",
        target: "fail-here",
        kind: "timedOut",
      },
    ],
  };

  it("compiles end-exited to await ctx.exit() and end-failed to a throw", () => {
    const output = generateJourneyFile(makeBlueprint(terminalsGraph), {
      journeyId: "terminals-demo",
    });
    // end-exited: the orchestration primitive, NOT a plain return.
    expect(output).toContain("await ctx.exit();");
    // end-failed: an idiomatic throw whose message names the node.
    expect(output).toContain(
      'throw new Error("journey reached the \\"fail-here\\" end-failed terminal");',
    );
    expectValidTs(output);
  });

  it("keeps end-completed as a plain fall-through (no ctx.exit / no throw)", () => {
    const output = generateJourneyFile(seedBlueprint, {
      journeyId: "activation-nudge",
    });
    // The seed's conditional-true edge ends on end-completed — an empty branch.
    expect(output).toContain("// (the journey ends on this branch)");
    expect(output).not.toContain("ctx.exit()");
    expect(output).not.toContain("end-failed terminal");
  });
});

// ---------------------------------------------------------------------------
// 3. non-EventCondition decisions become honest TODO stubs
// ---------------------------------------------------------------------------

describe("generateJourneyFile — unsupported condition types", () => {
  const propertyCondition: ConditionEval = {
    type: "property",
    property: "plan",
    operator: "eq",
    value: "pro",
  };
  const graph: BlueprintGraph = {
    journeyId: "todo-demo",
    nodes: [
      { id: "start", type: "start", title: "demo.trigger" },
      {
        id: "check-plan",
        type: "decision",
        title: "Pro plan?",
        meta: { conditions: [propertyCondition] },
      },
      { id: "checkpoint-pro", type: "checkpoint", title: "Pro" },
      { id: "end-a", type: "end-completed", title: "Done" },
      { id: "end-b", type: "end-completed", title: "Done" },
    ],
    edges: [
      { id: "e1", source: "start", target: "check-plan" },
      {
        id: "e2",
        source: "check-plan",
        target: "checkpoint-pro",
        kind: "conditional-true",
      },
      {
        id: "e3",
        source: "check-plan",
        target: "end-b",
        kind: "conditional-false",
      },
      { id: "e4", source: "checkpoint-pro", target: "end-a" },
    ],
  };

  it("stubs the condition to false with a TODO marker and the raw JSON", () => {
    const output = generateJourneyFile(makeBlueprint(graph), {
      journeyId: "todo-demo",
    });
    expect(output).toContain(
      'TODO(promote-to-code): manually port this "property" condition from blueprint node "check-plan"',
    );
    // the raw condition JSON is carried verbatim in a comment
    expect(output).toContain(`// ${JSON.stringify(propertyCondition)}`);
    // the stub compiles as the never-true branch, wrapped in ctx.once like any
    // other decision so the generated structure is uniform
    expect(output).toContain(
      'const decisionCheckPlan = await ctx.once("decision:check-plan", async () => {',
    );
    expect(output).toContain("return false /* TODO(promote-to-code)");
    expect(output).toContain("if (decisionCheckPlan) {");
    expectValidTs(output);
  });
});

describe("compileCondition", () => {
  it("compiles exists / not_exists / count checks", () => {
    expect(
      compileCondition(
        { type: "event", eventName: "a.b", check: "exists" },
        "n1",
      ),
    ).toEqual({
      expression:
        '(await ctx.history.hasEvent({ userId: user.id, event: "a.b" })).found',
      comments: [],
    });
    expect(
      compileCondition(
        { type: "event", eventName: "a.b", check: "not_exists" },
        "n1",
      ).expression,
    ).toBe(
      '!(await ctx.history.hasEvent({ userId: user.id, event: "a.b" })).found',
    );
    expect(
      compileCondition(
        {
          type: "event",
          eventName: "a.b",
          check: "count",
          operator: "eq",
          value: 2,
        },
        "n1",
      ).expression,
    ).toBe(
      '(await ctx.history.hasEvent({ userId: user.id, event: "a.b" })).count === 2',
    );
  });

  it("includes within when present and degrades an operatorless count to > 0", () => {
    expect(
      compileCondition(
        {
          type: "event",
          eventName: "a.b",
          check: "exists",
          within: { hours: 24 },
        },
        "n1",
      ).expression,
    ).toBe(
      '(await ctx.history.hasEvent({ userId: user.id, event: "a.b", within: { hours: 24 } })).found',
    );
    expect(
      compileCondition(
        { type: "event", eventName: "a.b", check: "count" },
        "n1",
      ).expression,
    ).toBe(
      '(await ctx.history.hasEvent({ userId: user.id, event: "a.b" })).count > 0',
    );
  });

  it("joins multiple decision conditions with && in generated output", () => {
    const graph: BlueprintGraph = {
      journeyId: "and-demo",
      nodes: [
        { id: "start", type: "start", title: "demo.trigger" },
        {
          id: "check-both",
          type: "decision",
          title: "Both?",
          meta: {
            conditions: [
              { type: "event", eventName: "a.one", check: "exists" },
              { type: "event", eventName: "a.two", check: "not_exists" },
            ],
          },
        },
        { id: "end-a", type: "end-completed", title: "Done" },
        { id: "end-b", type: "end-completed", title: "Done" },
      ],
      edges: [
        { id: "e1", source: "start", target: "check-both" },
        {
          id: "e2",
          source: "check-both",
          target: "end-a",
          kind: "conditional-true",
        },
        {
          id: "e3",
          source: "check-both",
          target: "end-b",
          kind: "conditional-false",
        },
      ],
    };
    const output = generateJourneyFile(makeBlueprint(graph), {
      journeyId: "and-demo",
    });
    expect(output).toContain(
      '(await ctx.history.hasEvent({ userId: user.id, event: "a.one" })).found && !(await ctx.history.hasEvent({ userId: user.id, event: "a.two" })).found',
    );
    expectValidTs(output);
  });
});

// ---------------------------------------------------------------------------
// meta extras + connector import gating
// ---------------------------------------------------------------------------

describe("generateJourneyFile — meta extras and connectors", () => {
  const connectorGraph: BlueprintGraph = {
    journeyId: "connector-demo",
    nodes: [
      { id: "start", type: "start", title: "demo.trigger" },
      {
        id: "notify-discord",
        type: "connector",
        title: "Notify Discord",
        meta: { connectorId: "discord", action: "sendChannelMessage" },
      },
      { id: "end", type: "end-completed", title: "Done" },
    ],
    edges: [
      { id: "e1", source: "start", target: "notify-discord" },
      { id: "e2", source: "notify-discord", target: "end" },
    ],
  };

  it("emits triggerWhere, entryPeriod and exitOn when present", () => {
    const output = generateJourneyFile(
      makeBlueprint(connectorGraph, {
        description: "A synthetic blueprint with every meta field set.",
        triggerWhere: [
          { type: "property", property: "plan", operator: "eq", value: "pro" },
        ],
        entryLimit: "once_per_period",
        entryPeriod: { hours: 24 },
        exitOn: [{ event: "user.deleted" }],
        suppress: { hours: 12 },
      }),
      { journeyId: "connector-demo" },
    );
    expect(output).toContain(
      'description: "A synthetic blueprint with every meta field set.",',
    );
    expect(output).toContain(
      'trigger: { event: "demo.trigger", where: [{ type: "property", property: "plan", operator: "eq", value: "pro" }] },',
    );
    expect(output).toContain('entryLimit: "once_per_period",');
    expect(output).toContain("entryPeriod: { hours: 24 },");
    expect(output).toContain('exitOn: [{ event: "user.deleted" }],');
    expect(output).toContain("suppress: { hours: 12 },");
    expectValidTs(output);
  });

  it("imports sendConnectorAction only when a connector node exists", () => {
    const output = generateJourneyFile(makeBlueprint(connectorGraph), {
      journeyId: "connector-demo",
    });
    expect(output).toContain(
      'import { defineJourney, sendConnectorAction } from "@hogsend/engine";',
    );
    expect(output).toContain(
      'await sendConnectorAction({ connectorId: "discord", action: "sendChannelMessage", idempotencyLabel: "notify-discord" });',
    );
    expect(output).not.toContain("sendEmail");
    expectValidTs(output);
  });
});
