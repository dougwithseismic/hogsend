import type {
  JourneyGraph,
  JourneyGraphNode,
  JourneyGraphNodeType,
} from "@/lib/admin-api";

/**
 * Render a {@link JourneyGraph} as Mermaid `flowchart TD` source.
 *
 * Pure + dependency-free so it is unit-testable in isolation. Node ids in the
 * IR carry characters Mermaid forbids in identifiers (`:`, `{`, `.`, quotes,
 * spaces — e.g. `wait:{"hours":336}`), so every node is aliased to a safe
 * `n<index>` and its human title/subtitle rendered as the (escaped) label.
 */
export function toMermaid(graph: JourneyGraph): string {
  const alias = new Map<string, string>();
  graph.nodes.forEach((node, i) => {
    alias.set(node.id, `n${i}`);
  });

  const lines: string[] = ["flowchart TD"];

  for (const node of graph.nodes) {
    const id = alias.get(node.id);
    if (!id) continue;
    const [open, close] = shapeFor(node.type);
    lines.push(`  ${id}${open}"${labelFor(node)}"${close}`);
  }

  for (const edge of graph.edges) {
    const source = alias.get(edge.source);
    const target = alias.get(edge.target);
    if (!source || !target) continue;
    const label = edge.label ? `|"${escapeText(edge.label)}"|` : "";
    lines.push(`  ${source} -->${label} ${target}`);
  }

  return lines.join("\n");
}

/** Delimiters per node type: `[open]"text"[close]`. */
function shapeFor(type: JourneyGraphNodeType): [string, string] {
  switch (type) {
    case "start":
    case "end-completed":
    case "end-exited":
    case "end-failed":
      return ["([", "])"]; // stadium — terminals
    case "wait":
    case "branch":
      return ["{{", "}}"]; // hexagon — waits/branches
    case "trigger":
      return ["[/", "/]"]; // parallelogram — fan-out triggers
    default:
      return ["[", "]"]; // rectangle — steps
  }
}

function labelFor(node: JourneyGraphNode): string {
  const parts = [node.title];
  if (node.subtitle && node.subtitle !== node.title) parts.push(node.subtitle);
  return escapeText(parts.join(" — "));
}

/**
 * Escape label text for a Mermaid quoted string: collapse newlines, and swap
 * double quotes for single quotes so the `"…"` wrapper can never be broken.
 */
export function escapeText(value: string): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/"/g, "'")
    .trim();
}
