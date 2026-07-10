/** Output helpers shared by the tools — compact text for the model's context,
 * full data in `structuredContent`, deep links so a human can click through. */

import type { Finding } from "./findings.js";

export function pct(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

/** Studio deep link (baseUrl is the API origin; Studio is served under it). */
export function deepLink(baseUrl: string, path: string): string {
  return `${baseUrl}/studio${path.startsWith("/") ? path : `/${path}`}`;
}

/** Truncate rendered HTML for context discipline (~2KB, whole tags kept). */
export function truncateHtml(html: string, max = 2048): string {
  if (html.length <= max) return html;
  const cut = html.slice(0, max);
  const lastClose = cut.lastIndexOf(">");
  return `${cut.slice(0, lastClose + 1)}\n<!-- …truncated (${html.length} chars total) -->`;
}

/** Render a graph's nodes as a compact table (id | type | title | live | failed). */
export function nodeTable(
  nodes: Array<{ id: string; type: string; title?: string }>,
  metrics: Record<string, { live: number; failed: number }>,
): string {
  const lines = ["node | type | title | live | failed"];
  for (const node of nodes) {
    const m = metrics[node.id] ?? { live: 0, failed: 0 };
    lines.push(
      `${node.id} | ${node.type} | ${node.title ?? ""} | ${m.live} | ${m.failed}`,
    );
  }
  return lines.join("\n");
}

const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 } as const;

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );
}

/** Ranked compact text rendering of findings for the model. */
export function renderFindings(findings: Finding[]): string {
  if (findings.length === 0) {
    return "No findings — everything within healthy thresholds.";
  }
  return sortFindings(findings)
    .map(
      (f, i) =>
        `${i + 1}. [${f.severity.toUpperCase()}] (${f.area}) ${f.finding}\n   → ${f.suggested_action}`,
    )
    .join("\n");
}
