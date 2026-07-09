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
      type: "branch",
      title: "Wait for answer",
      meta: { event: "nps.answered", timeout: { days: 3 } },
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
      expect(result.data.nodes).toHaveLength(4);
      expect(result.data.edges).toHaveLength(3);
    }
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
