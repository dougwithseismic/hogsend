import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderMermaid } from "@hogsend/core/graph";
import { renderMermaidASCII } from "beautiful-mermaid";
import { describe, expect, it } from "vitest";
import { extractJourneyGraph, extractJourneyId } from "../lib/journey-graph.js";
import { discoverJourneyFiles } from "../lib/journey-graph-docs.js";

/**
 * Whole-app graph smoke: discover EVERY journey the dogfood app ships, extract
 * its control-flow graph, render both Mermaid variants, parse the plain variant
 * with a real text parser, and assert the structural invariants that keep the
 * diagram valid everywhere (GitHub, docs, mermaid.live, terminal ASCII).
 *
 * This is the CI guard against a new journey (or an extractor change) emitting
 * a parser-hostile or malformed graph. It runs against the sibling apps/api
 * source in the monorepo; when that source isn't present (e.g. the published
 * package in isolation) the suite skips.
 */

const JOURNEYS_DIR = fileURLToPath(
  new URL("../../../../apps/api/src/journeys", import.meta.url),
);

/** Identical (from,to,kind,label) edges are a bug — dedupe should never fire. */
function duplicateEdges(
  edges: ReturnType<typeof extractJourneyGraph>["edges"],
) {
  return edges.filter((edge, index) =>
    edges.some(
      (other, otherIndex) =>
        otherIndex !== index &&
        other.from === edge.from &&
        other.to === edge.to &&
        other.kind === edge.kind &&
        other.label === edge.label,
    ),
  );
}

const hasApp = existsSync(JOURNEYS_DIR);

describe.skipIf(!hasApp)("whole-app journey graphs", () => {
  // Only files that actually define a journey (skips barrels/constants).
  const journeyFiles = discoverJourneyFiles(JOURNEYS_DIR).filter((f) =>
    Boolean(extractJourneyId(f)),
  );

  it("discovers the app's journeys", () => {
    expect(journeyFiles.length).toBeGreaterThan(0);
  });

  it.each(journeyFiles)("extracts + renders a valid graph: %s", (file) => {
    const graph = extractJourneyGraph(file);
    expect(graph.sourceLevel).toBe("rich");
    expect(graph.nodes.length).toBeGreaterThan(0);

    // Full variant (browser/docs/GitHub): valid flowchart, parser-safe classes.
    const full = renderMermaid(graph);
    expect(full).toContain("flowchart TD");
    // Reserved lowercase `end` must never appear as a raw class / annotation.
    expect(full).not.toContain("classDef end ");
    expect(full).not.toContain(":::end");
    // Class names are prefixed, never hyphenated (mermaid rejects hyphens).
    expect(full).not.toMatch(/classDef kind-[a-z]/);

    // No two edges are byte-identical (branch de-dup invariant).
    expect(duplicateEdges(graph.edges)).toHaveLength(0);

    // Plain variant must parse in a real text renderer without throwing.
    const plain = renderMermaid(graph, { variant: "plain" });
    let ascii = "";
    expect(() => {
      ascii = renderMermaidASCII(plain, {
        boxBorderPadding: 0,
        colorMode: "none",
        paddingX: 1,
        paddingY: 1,
      });
    }).not.toThrow();
    expect(ascii.length).toBeGreaterThan(0);
  });
});
