import { describe, expect, it } from "vitest";
import type { JourneyMeta } from "../../types/journey.js";
import { renderMermaid } from "../mermaid.js";
import { metaToGraph } from "../meta.js";
import type { JourneyGraph } from "../types.js";

/** A small synthetic graph exercising every node shape and edge kind. */
function sampleGraph(): JourneyGraph {
  return {
    journeyId: "demo",
    sourceLevel: "rich",
    nodes: [
      { id: "n1", kind: "trigger", label: "payment.failed" },
      {
        id: "n2",
        kind: "email",
        label: "Payment failed",
        detail: "churn.payment_failed",
      },
      {
        id: "n3",
        kind: "sleep",
        label: "first-retry",
        detail: "1d",
        countKey: "first-retry",
      },
      { id: "n4", kind: "branch", label: "hasRetried" },
      { id: "n5", kind: "end", label: "end" },
      { id: "n6", kind: "wait", label: "await-score", detail: "timeout 3d" },
      { id: "n7", kind: "checkpoint", label: "scored-9", countKey: "scored-9" },
      { id: "n8", kind: "trigger-event", label: "nps.detractor" },
      { id: "n9", kind: "exit", label: "subscription.cancelled" },
      { id: "n10", kind: "inapp", label: "Welcome", detail: "sendFeedItem" },
      { id: "n11", kind: "connector", label: "discord/sendChannelMessage" },
      { id: "n12", kind: "schedule", label: "post-welcome", detail: "days(2)" },
    ],
    edges: [
      { from: "n1", to: "n2", kind: "main" },
      { from: "n2", to: "n3", kind: "main" },
      { from: "n3", to: "n4", kind: "main" },
      { from: "n4", to: "n5", label: "yes", kind: "yes" },
      { from: "n4", to: "n6", label: "no", kind: "no" },
      { from: "n6", to: "n7", label: "fired", kind: "fired" },
      { from: "n6", to: "n5", label: "timed out", kind: "timeout" },
      { from: "n7", to: "n8", kind: "main" },
    ],
  };
}

describe("renderMermaid", () => {
  it("renders a flowchart TD with a correct init directive, classDefs, nodes and edges", () => {
    const out = renderMermaid(sampleGraph());
    // The directive MUST wrap themeVariables in `init:` — a bare
    // `%%{ themeVariables }%%` is silently ignored by Mermaid.
    expect(out).toContain("%%{ init: { themeVariables:");
    expect(out).not.toContain("%%init%%\n"); // the old malformed bare line
    expect(out).toContain("flowchart TD");
    // One classDef per used kind
    expect(out).toContain(
      "classDef kind_email fill:#f64838,stroke:#b8281c,color:#fff;",
    );
    expect(out).toContain(
      "classDef kind_sleep fill:#1f2937,stroke:#374151,color:#fff;",
    );
    expect(out).toContain(
      "classDef kind_wait fill:#111827,stroke:#f64838,color:#fff;",
    );
    expect(out).toContain(
      "classDef kind_branch fill:#111827,stroke:#f64838,color:#fff;",
    );
    expect(out).toContain(
      "classDef kind_end fill:#1f2937,stroke:#374151,color:#9ca3af;",
    );
    expect(out).not.toContain("classDef end ");
    // Highlight class always present
    expect(out).toContain("classDef hl stroke:#f64838,stroke-width:3px;");
    // Shape per kind — the FULL variant wraps every label in double quotes and
    // uses exact mermaid shape syntax (asymmetric is `>text]`, not `>[text]`).
    expect(out).toContain('n1(["payment.failed"]):::kind_trigger');
    expect(out).toContain(
      'n2["send: Payment failed — churn.payment_failed"]:::kind_email',
    );
    expect(out).toContain('n4{"hasRetried"}:::kind_branch');
    expect(out).toContain('n6{"await-score — timeout 3d"}:::kind_wait');
    expect(out).toContain('n7[["scored-9"]]:::kind_checkpoint');
    expect(out).toContain('n8>"trigger: nps.detractor"]:::kind_trigger_event');
    expect(out).toContain('n5((("end"))):::kind_end');
    // The illegal `>[` asymmetric form must never appear.
    expect(out).not.toContain(">[");
    // Edges with labels
    expect(out).toContain("n4 -->|yes| n5");
    expect(out).toContain("n6 -->|fired| n7");
    expect(out).toContain("n6 -->|timed out| n5");
    expect(out).toContain("n1 --> n2"); // unlabeled main edge
  });

  it("renders a plain variant with no directive/classDefs and sanitized labels", () => {
    const out = renderMermaid(sampleGraph(), { variant: "plain" });
    // No theme directive, no classDefs, no class annotations.
    expect(out).not.toContain("%%{ init:");
    expect(out).not.toContain("classDef");
    expect(out).not.toContain(":::");
    expect(out).toContain("flowchart TD");
    // Bracketed kind tags become `send:` style prefixes (text parsers choke
    // on brackets), and the em-dash joiner becomes a plain hyphen.
    expect(out).toContain("send: Payment failed - churn.payment_failed");
    expect(out).not.toContain("[send]");
    expect(out).not.toContain("—");
    // Edges keep their labels.
    expect(out).toContain("n4 -->|yes| n5");
  });

  it("escapes characters that break mermaid syntax (incl. <> XSS vector and #)", () => {
    const graph: JourneyGraph = {
      journeyId: "x",
      sourceLevel: "rich",
      nodes: [
        {
          id: "n1",
          kind: "email",
          label: 'He said "hi" [tag] {brace} (parens) #hash <img src=x>',
        },
        { id: "n2", kind: "end", label: "end" },
      ],
      edges: [{ from: "n1", to: "n2", kind: "main" }],
    };
    const out = renderMermaid(graph);
    // Labels are double-quoted, so a literal quote must be encoded (else it
    // would close the string) — brackets/braces/parens are now SAFE inside the
    // quotes and kept verbatim.
    expect(out).not.toContain('"hi"');
    expect(out).toContain("#quot;hi#quot;");
    expect(out).toContain("[tag]");
    expect(out).toContain("{brace}");
    expect(out).toContain("(parens)");
    // <> must be entity-escaped (the docs component renders htmlLabels) — a
    // raw <img> must NOT survive into the output.
    expect(out).not.toContain("<img src=x>");
    expect(out).toContain("&lt;img src=x&gt;");
    // `#` is encoded as the mermaid entity (kept literal, not a comment start).
    expect(out).toContain("#35;hash");
  });

  it("emits highlight class assignments when highlight ids are given", () => {
    const out = renderMermaid(sampleGraph(), { highlight: ["n2", "n6"] });
    expect(out).toContain("class n2,n6 hl;");
  });

  it("is deterministic across calls (stable snapshot)", () => {
    const a = renderMermaid(sampleGraph());
    const b = renderMermaid(sampleGraph());
    expect(a).toBe(b);
  });
});

describe("metaToGraph", () => {
  const meta: JourneyMeta = {
    id: "churn-prevention",
    name: "Churn",
    enabled: true,
    trigger: { event: "payment.failed" },
    entryLimit: "once_per_period",
    suppress: { hours: 4 },
    exitOn: [
      { event: "payment.succeeded" },
      { event: "subscription.cancelled" },
    ],
  };

  it("produces a metadata-level skeleton with trigger, body, exits, end", () => {
    const g = metaToGraph(meta);
    expect(g.sourceLevel).toBe("metadata");
    expect(g.journeyId).toBe("churn-prevention");
    const kinds = g.nodes.map((n) => n.kind);
    expect(kinds).toContain("trigger");
    expect(kinds).toContain("checkpoint"); // body placeholder
    expect(kinds.filter((k) => k === "exit")).toHaveLength(2);
    expect(kinds).toContain("end");
    // trigger -> body -> end chain exists
    expect(
      g.edges.some((e) => e.from === g.nodes[0]?.id && e.to === g.nodes[1]?.id),
    ).toBe(true);
  });

  it("includes a disclaimer explaining the fallback", () => {
    const g = metaToGraph(meta);
    expect(g.disclaimer).toContain("Metadata-only");
  });

  it("renders to valid mermaid without throwing", () => {
    const g = metaToGraph(meta);
    const m = renderMermaid(g);
    expect(m).toContain("flowchart TD");
    expect(m).toContain("payment.failed");
  });
});
