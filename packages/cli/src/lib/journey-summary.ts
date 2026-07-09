import type { GraphNode, JourneyGraph } from "@hogsend/core";

/**
 * Terse, agent-oriented Markdown digest of a {@link JourneyGraph}.
 *
 * The CLI's `--format summary` output. Where `mermaid` is for eyes and
 * `--json` is for machines that will re-walk the structure, `summary` is the
 * middle ground: a compact, human- AND agent-readable rundown of what the
 * journey actually does — trigger, exits, and every send / wait / branch /
 * sleep with its source pointer — that drops cleanly into a PR description or
 * an agent's scratchpad. No box art.
 */

/** A node with a resolved `file:line` (or just `file`, or just `:line`). */
function pointer(sourceFile: string | undefined, node: GraphNode): string {
  if (sourceFile && node.sourceLine) return `${sourceFile}:${node.sourceLine}`;
  if (sourceFile) return sourceFile;
  if (node.sourceLine) return `:${node.sourceLine}`;
  return "";
}

/** `text (`file:line`)` — the pointer is dropped when unknown. */
function withPointer(text: string, ptr: string): string {
  return ptr ? `${text} (\`${ptr}\`)` : text;
}

/** One markdown line per node, formatted for its kind. */
function lineForNode(node: GraphNode, sourceFile: string | undefined): string {
  const ptr = pointer(sourceFile, node);
  switch (node.kind) {
    case "email": {
      // Subject is the label; template ref (resolved key preferred) is detail.
      const tmpl = node.templateKey ?? node.templateRef ?? node.detail;
      const body = tmpl
        ? `\`${node.label}\` — template \`${tmpl}\``
        : `\`${node.label}\``;
      return withPointer(body, ptr);
    }
    case "wait": {
      const detail = node.detail ? ` — ${node.detail}` : "";
      return withPointer(`event \`${node.label}\`${detail}`, ptr);
    }
    case "branch":
      return withPointer(`\`${node.label}\``, ptr);
    case "sleep":
    case "schedule": {
      const detail = node.detail ? ` — \`${node.detail}\`` : "";
      return withPointer(`${node.label}${detail}`, ptr);
    }
    case "trigger-event":
      return withPointer(`\`${node.label}\``, ptr);
    default: {
      const detail = node.detail ? ` — ${node.detail}` : "";
      return withPointer(`${node.label}${detail}`, ptr);
    }
  }
}

/** Ordered sections: kind(s) → heading. First match wins for display order. */
const SECTIONS: Array<{ title: string; kinds: GraphNode["kind"][] }> = [
  { title: "Sends", kinds: ["email"] },
  { title: "In-app", kinds: ["inapp"] },
  { title: "Connectors", kinds: ["connector"] },
  { title: "Waits", kinds: ["wait"] },
  { title: "Branches", kinds: ["branch"] },
  { title: "Sleeps & schedules", kinds: ["sleep", "schedule"] },
  { title: "Emitted events", kinds: ["trigger-event"] },
  { title: "Checkpoints", kinds: ["checkpoint"] },
];

/**
 * Render a journey graph as a Markdown summary. Deterministic (nodes are
 * iterated in extraction order) so it snapshot-tests cleanly.
 */
export function renderJourneySummary(graph: JourneyGraph): string {
  const lines: string[] = [];
  const trigger = graph.nodes.find((n) => n.kind === "trigger");
  const exits = graph.nodes.filter((n) => n.kind === "exit");

  lines.push(`# ${graph.journeyId}`);
  lines.push("");
  if (graph.sourceFile) {
    lines.push(`**Source:** \`${graph.sourceFile}\``);
    lines.push("");
  }

  // Meta table.
  lines.push("| | |");
  lines.push("| --- | --- |");
  lines.push(`| Trigger | \`${trigger?.label ?? "?"}\` |`);
  if (exits.length > 0) {
    lines.push(
      `| Exit on | ${exits.map((e) => `\`${e.label}\``).join(", ")} |`,
    );
  }
  lines.push(`| Nodes | ${graph.nodes.length} |`);
  lines.push(`| Fidelity | ${graph.sourceLevel} |`);
  lines.push("");

  // One section per node group that has content.
  for (const section of SECTIONS) {
    const nodes = graph.nodes.filter((n) => section.kinds.includes(n.kind));
    if (nodes.length === 0) continue;
    lines.push(`## ${section.title}`);
    lines.push("");
    for (const node of nodes) {
      lines.push(`- ${lineForNode(node, graph.sourceFile)}`);
    }
    lines.push("");
  }

  if (graph.disclaimer) {
    lines.push(`> ${graph.disclaimer}`);
    lines.push("");
  }

  // Trim the trailing blank line for a stable, fence-free tail.
  return `${lines.join("\n").trimEnd()}\n`;
}
