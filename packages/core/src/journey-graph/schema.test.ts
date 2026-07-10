import { describe, expect, it } from "vitest";
import { journeyGraphSchema } from "./schema.js";
import type { JourneyGraph } from "./types.js";

const validGraph: JourneyGraph = {
  journeyId: "feedback-nps",
  nodes: [
    { id: "start", type: "start", title: "Start", subtitle: "nps.requested" },
    {
      id: "wait:14d",
      type: "sleep",
      title: "Wait",
      subtitle: "14 days",
      meta: { duration: { days: 14 } },
    },
    {
      id: "wait-event:nps.answered",
      type: "wait",
      title: "Wait for answer",
      meta: { event: "nps.answered", timeout: { days: 3 } },
    },
    {
      id: "check-detractor",
      type: "branch",
      title: "Detractor?",
      meta: {
        conditions: [
          { type: "property", property: "score", operator: "lte", value: 6 },
        ],
      },
    },
    { id: "end-completed", type: "end-completed", title: "Completed" },
  ],
  edges: [
    { id: "e1", source: "start", target: "wait:14d", label: "14 days" },
    {
      id: "e2",
      source: "wait:14d",
      target: "wait-event:nps.answered",
    },
    {
      id: "e3",
      source: "wait-event:nps.answered",
      target: "end-completed",
      label: "answered",
      kind: "answered",
    },
  ],
};

describe("journeyGraphSchema", () => {
  it("parses a valid hand-written graph", () => {
    const result = journeyGraphSchema.safeParse(validGraph);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.journeyId).toBe("feedback-nps");
      expect(result.data.nodes).toHaveLength(5);
      expect(result.data.edges).toHaveLength(3);
    }
  });

  it("reports per-branch, per-field errors (discriminated union)", () => {
    // The validator knows the node is a `sleep` BEFORE validating it, so a
    // wrong-typed field errors at its exact path instead of a generic
    // whole-object union failure.
    const bad = {
      ...validGraph,
      nodes: [
        {
          id: "wait:1d",
          type: "sleep",
          title: "Sleep",
          meta: { duration: { hours: "not-a-number" } },
        },
      ],
    };
    const result = journeyGraphSchema.safeParse(bad);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual([
        "nodes",
        0,
        "meta",
        "duration",
        "hours",
      ]);
    }
  });

  it("validates decision conditions against the real condition vocabulary", () => {
    const bad = {
      ...validGraph,
      nodes: [
        {
          id: "check",
          type: "decision",
          title: "Check",
          meta: { conditions: [{ type: "not-a-condition" }] },
        },
      ],
    };
    expect(journeyGraphSchema.safeParse(bad).success).toBe(false);
  });

  it("accepts a digest node type", () => {
    const withDigest = {
      ...validGraph,
      nodes: [
        ...validGraph.nodes,
        {
          id: "digest:order.placed",
          type: "digest",
          title: "Digest",
          subtitle: "1 hour",
          meta: { event: "order.placed", duration: { hours: 1 } },
        },
      ],
    };
    expect(journeyGraphSchema.safeParse(withDigest).success).toBe(true);
  });

  it("rejects a node with an invalid type", () => {
    const bad = {
      ...validGraph,
      nodes: [
        ...validGraph.nodes,
        { id: "x", type: "not-a-real-type", title: "X" },
      ],
    };
    expect(journeyGraphSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an edge missing target", () => {
    const bad = {
      ...validGraph,
      edges: [{ id: "e-bad", source: "start" }],
    };
    expect(journeyGraphSchema.safeParse(bad).success).toBe(false);
  });
});
