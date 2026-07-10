import { describe, expect, it } from "vitest";
import {
  type BlueprintGraph,
  type BlueprintValidationIssue,
  validateBlueprintGraph,
} from "./blueprint.js";

// The spec §7 worked example — "3 days after signup, nudge if not activated".
const validBlueprint = {
  journeyId: "signup-activation-nudge",
  nodes: [
    { id: "start", type: "start", title: "signup.completed" },
    {
      id: "wait:3d",
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
          { type: "event", eventName: "feature.used", check: "exists" },
        ],
      },
    },
    {
      id: "send-nudge",
      type: "send",
      title: "Send activation nudge",
      meta: { template: "activation-nudge" },
    },
    { id: "end-ok", type: "end-completed", title: "Done" },
  ],
  edges: [
    { id: "e1", source: "start", target: "wait:3d" },
    { id: "e2", source: "wait:3d", target: "check-activated" },
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
} satisfies BlueprintGraph;

function issuesOf(graph: unknown): BlueprintValidationIssue[] {
  const result = validateBlueprintGraph(graph);
  expect(result.valid).toBe(false);
  return result.valid ? [] : result.issues;
}

function withNodes(nodes: unknown[], edges = validBlueprint.edges): unknown {
  return { ...validBlueprint, nodes, edges };
}

describe("validateBlueprintGraph", () => {
  it("accepts a fully-valid blueprint graph", () => {
    const result = validateBlueprintGraph(validBlueprint);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.graph.journeyId).toBe("signup-activation-nudge");
      expect(result.graph.nodes).toHaveLength(5);
      expect(result.graph.edges).toHaveLength(5);
    }
  });

  it("accepts a wait node forking into an answered/timedOut pair", () => {
    const graph = {
      journeyId: "wait-fork",
      nodes: [
        { id: "start", type: "start", title: "nps.requested" },
        {
          id: "wait-answer",
          type: "wait",
          title: "Wait for answer",
          meta: { event: "nps.answered", timeout: { hours: 72 } },
        },
        {
          id: "notify-team",
          type: "connector",
          title: "Notify team",
          meta: { connectorId: "discord", action: "send-message" },
        },
        {
          id: "nudge",
          type: "trigger",
          title: "Re-ask",
          meta: { event: "nps.requested.again" },
        },
        { id: "end-ok", type: "end-completed", title: "Done" },
        { id: "end-quiet", type: "end-exited", title: "No answer" },
      ],
      edges: [
        { id: "e1", source: "start", target: "wait-answer" },
        {
          id: "e2",
          source: "wait-answer",
          target: "notify-team",
          kind: "answered",
        },
        {
          id: "e3",
          source: "wait-answer",
          target: "nudge",
          kind: "timedOut",
        },
        { id: "e4", source: "notify-team", target: "end-ok" },
        { id: "e5", source: "nudge", target: "end-quiet" },
      ],
    };
    expect(validateBlueprintGraph(graph).valid).toBe(true);
  });

  it("rejects a send node missing its template, naming the node", () => {
    const nodes = validBlueprint.nodes.map((node) =>
      node.id === "send-nudge" ? { ...node, meta: {} } : node,
    );
    const issues = issuesOf(withNodes(nodes));
    const issue = issues.find((i) => i.nodeId === "send-nudge");
    expect(issue).toBeDefined();
    expect(issue?.code).toBe("invalid_type");
    expect(issue?.path).toEqual(["nodes", 3, "meta", "template"]);
    expect(issue?.message).toContain('node "send-nudge"');
  });

  it("rejects a sleep node with no meta at all", () => {
    const nodes = validBlueprint.nodes.map((node) =>
      node.id === "wait:3d"
        ? { id: node.id, type: node.type, title: node.title }
        : node,
    );
    const issues = issuesOf(withNodes(nodes));
    const issue = issues.find((i) => i.nodeId === "wait:3d");
    expect(issue?.code).toBe("invalid_type");
    expect(issue?.path).toEqual(["nodes", 1, "meta"]);
  });

  it("rejects a non-DurationObject sleep duration (silent zero-sleep trap)", () => {
    const nodes = validBlueprint.nodes.map((node) =>
      node.id === "wait:3d"
        ? { ...node, meta: { duration: { days: 3 } } }
        : node,
    );
    const issues = issuesOf(withNodes(nodes));
    const issue = issues.find(
      (i) => i.nodeId === "wait:3d" && i.code === "unrecognized_keys",
    );
    expect(issue).toBeDefined();
  });

  it("rejects a wait node missing its timeout", () => {
    const graph = withNodes([
      ...validBlueprint.nodes,
      {
        id: "wait-answer",
        type: "wait",
        title: "Wait",
        meta: { event: "nps.answered" },
      },
    ]);
    const issues = issuesOf(graph);
    const issue = issues.find(
      (i) => i.nodeId === "wait-answer" && i.path.includes("timeout"),
    );
    expect(issue?.code).toBe("invalid_type");
  });

  it("rejects a decision node with empty conditions", () => {
    const nodes = validBlueprint.nodes.map((node) =>
      node.id === "check-activated"
        ? { ...node, meta: { conditions: [] } }
        : node,
    );
    const issues = issuesOf(withNodes(nodes));
    const issue = issues.find((i) => i.nodeId === "check-activated");
    expect(issue?.code).toBe("too_small");
    expect(issue?.path).toEqual(["nodes", 2, "meta", "conditions"]);
  });

  it("validates decision conditions against the real condition vocabulary", () => {
    const nodes = validBlueprint.nodes.map((node) =>
      node.id === "check-activated"
        ? { ...node, meta: { conditions: [{ type: "not-a-condition" }] } }
        : node,
    );
    const issues = issuesOf(withNodes(nodes));
    expect(issues.some((i) => i.nodeId === "check-activated")).toBe(true);
  });

  it("rejects a digest node (v1 defense-in-depth)", () => {
    const graph = withNodes(
      [
        ...validBlueprint.nodes,
        { id: "digest:orders", type: "digest", title: "Digest" },
      ],
      [
        ...validBlueprint.edges,
        { id: "e6", source: "end-ok", target: "digest:orders" },
      ],
    );
    const issues = issuesOf(graph);
    const issue = issues.find((i) => i.code === "unsupported_node_type");
    expect(issue?.nodeId).toBe("digest:orders");
    expect(issue?.message).toContain(
      "digest nodes are not supported in blueprints (v1)",
    );
  });

  it("rejects an unknown node", () => {
    const graph = withNodes(
      [
        ...validBlueprint.nodes,
        { id: "mystery", type: "unknown", title: "???" },
      ],
      [
        ...validBlueprint.edges,
        { id: "e6", source: "end-ok", target: "mystery" },
      ],
    );
    const issues = issuesOf(graph);
    const issue = issues.find((i) => i.code === "unsupported_node_type");
    expect(issue?.nodeId).toBe("mystery");
    expect(issue?.message).toContain("unknown nodes are not executable");
  });

  it("rejects sleepUntil and capture nodes (no executable meta in the IR yet)", () => {
    for (const type of ["sleepUntil", "capture"]) {
      const graph = withNodes(
        [...validBlueprint.nodes, { id: `x-${type}`, type, title: type }],
        [
          ...validBlueprint.edges,
          { id: "e6", source: "end-ok", target: `x-${type}` },
        ],
      );
      const issues = issuesOf(graph);
      const issue = issues.find((i) => i.code === "unsupported_node_type");
      expect(issue?.nodeId).toBe(`x-${type}`);
    }
  });

  it("rejects degraded graphs outright", () => {
    const issues = issuesOf({ ...validBlueprint, degraded: true });
    const issue = issues.find((i) => i.code === "degraded_graph");
    expect(issue).toBeDefined();
    expect(issue?.path).toEqual(["degraded"]);
  });

  it("accepts an explicit degraded: false", () => {
    expect(
      validateBlueprintGraph({ ...validBlueprint, degraded: false }).valid,
    ).toBe(true);
  });

  it("rejects graphs with warnings (zero tolerance)", () => {
    const issues = issuesOf({
      ...validBlueprint,
      warnings: ["dynamic template"],
    });
    const issue = issues.find((i) => i.code === "graph_has_warnings");
    expect(issue).toBeDefined();
    expect(issue?.path).toEqual(["warnings"]);
  });

  it("rejects cyclic graphs, naming the back edge", () => {
    const edges = validBlueprint.edges.map((edge) =>
      edge.id === "e5" ? { ...edge, target: "wait:3d" } : edge,
    );
    const issues = issuesOf({ ...validBlueprint, edges });
    const issue = issues.find((i) => i.code === "cyclic_graph");
    expect(issue?.edgeId).toBe("e5");
  });

  it("rejects unreachable nodes, naming them", () => {
    const graph = withNodes([
      ...validBlueprint.nodes,
      { id: "orphan", type: "checkpoint", title: "Orphan" },
    ]);
    const issues = issuesOf(graph);
    const issue = issues.find((i) => i.code === "unreachable_node");
    expect(issue?.nodeId).toBe("orphan");
  });

  it("rejects a graph with no start node", () => {
    const graph = withNodes(
      validBlueprint.nodes.filter((node) => node.id !== "start"),
      validBlueprint.edges.filter((edge) => edge.id !== "e1"),
    );
    const issues = issuesOf(graph);
    expect(issues.some((i) => i.code === "missing_start_node")).toBe(true);
  });

  it("rejects duplicate node ids", () => {
    const graph = withNodes([
      ...validBlueprint.nodes,
      { id: "end-ok", type: "end-completed", title: "Done again" },
    ]);
    const issues = issuesOf(graph);
    const issue = issues.find((i) => i.code === "duplicate_node_id");
    expect(issue?.nodeId).toBe("end-ok");
  });

  it("rejects edges pointing at nonexistent nodes", () => {
    const edges = validBlueprint.edges.map((edge) =>
      edge.id === "e5" ? { ...edge, target: "nope" } : edge,
    );
    const issues = issuesOf({ ...validBlueprint, edges });
    const issue = issues.find((i) => i.code === "unknown_edge_target");
    expect(issue?.edgeId).toBe("e5");
  });

  it("rejects decision nodes without a true/false edge pair", () => {
    const edges = validBlueprint.edges.map((edge) =>
      edge.id === "e4" ? { ...edge, kind: "default" } : edge,
    );
    const issues = issuesOf({ ...validBlueprint, edges });
    const issue = issues.find((i) => i.code === "invalid_decision_edges");
    expect(issue?.nodeId).toBe("check-activated");
  });

  it("rejects ambiguous fan-out from a non-forking node", () => {
    const issues = issuesOf({
      ...validBlueprint,
      edges: [
        ...validBlueprint.edges,
        { id: "e6", source: "wait:3d", target: "send-nudge" },
      ],
    });
    const issue = issues.find((i) => i.code === "ambiguous_fan_out");
    expect(issue?.nodeId).toBe("wait:3d");
  });

  it("rejects terminal nodes with outgoing edges", () => {
    const issues = issuesOf({
      ...validBlueprint,
      edges: [
        ...validBlueprint.edges,
        { id: "e6", source: "end-ok", target: "send-nudge" },
      ],
    });
    const issue = issues.find(
      (i) => i.code === "terminal_node_has_outgoing_edges",
    );
    expect(issue?.nodeId).toBe("end-ok");
  });

  it("returns structured issues for non-object input", () => {
    const result = validateBlueprintGraph(42);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues[0]?.code).toBeTruthy();
    }
  });
});
