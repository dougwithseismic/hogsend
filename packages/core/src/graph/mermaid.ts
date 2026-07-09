import type {
  GraphKind,
  GraphNode,
  JourneyGraph,
  RenderMermaidOptions,
} from "./types.js";

/**
 * Mermaid styling for each node kind. Emitted as `classDef` lines at the top of
 * the diagram, then applied via `class <nodeId> <className>;`. The palette is
 * tuned to read on BOTH GitHub (light) and the dark docs/Studio theme:
 *   - email/trigger/exit lean on the brand red (#f64838)
 *   - waits/branches use near-black fill with a red stroke (decisions)
 *   - sleeps/schedules use neutral slate
 *
 * `%%init%% { "themeVariables": { ... } }` sets a dark background for the docs
 * site render; GitHub ignores `%%init%%` and shows the default light canvas —
 * both stay legible because the fills carry their own contrast.
 */
const CLASS_DEFS: Record<GraphKind, string> = {
  trigger: "fill:#f6483822,stroke:#f64838,color:#f64838",
  email: "fill:#f64838,stroke:#b8281c,color:#fff",
  inapp: "fill:#2a2a2a,stroke:#f64838,color:#fff",
  connector: "fill:#2a2a2a,stroke:#6b7280,color:#fff",
  sleep: "fill:#1f2937,stroke:#374151,color:#fff",
  schedule: "fill:#1f2937,stroke:#374151,color:#fff",
  wait: "fill:#111827,stroke:#f64838,color:#fff",
  branch: "fill:#111827,stroke:#f64838,color:#fff",
  "trigger-event": "fill:#2a2a2a,stroke:#f64838,color:#f64838",
  checkpoint: "fill:#2a2a2a,stroke:#6b7280,color:#9ca3af",
  exit: "fill:#2a2a2a,stroke:#f64838,color:#f64838",
  end: "fill:#1f2937,stroke:#374151,color:#9ca3af",
};

function className(kind: GraphKind): string {
  return `kind_${kind.replace(/-/g, "_")}`;
}

/**
 * Mermaid shape wrappers per kind. `%label` = the (already-escaped) label.
 *
 * TWO maps because the two renderers have different tolerances:
 *   - FULL (browser mermaid: GitHub, docs, mermaid.live) is strict. Every label
 *     is wrapped in double quotes — the documented way to carry special
 *     characters safely — and shapes use exact mermaid syntax (asymmetric is
 *     `>text]`, NOT `>[text]`; the stray `[` was a hard parse error).
 *   - PLAIN (terminal ASCII via beautiful-mermaid) parses unquoted node text;
 *     labels are pre-sanitized by `plainLabel`, so shapes stay quote-free.
 *
 * Shapes are chosen so a glance distinguishes roles:
 *   ([ ])   stadium   — trigger / sleep / schedule (entry & time)
 *   [ ]     rectangle — channel sends (email/inapp/connector) / exit
 *   { }     rhombus   — decisions (wait / branch)
 *   [[ ]]   subroutine — checkpoint
 *   ((( ))) double-circle — terminal end
 *   > ]     asymmetric — emitted trigger-event
 */
const SHAPES_FULL: Record<GraphKind, string> = {
  trigger: '(["%label"])',
  email: '["%label"]',
  inapp: '["%label"]',
  connector: '["%label"]',
  sleep: '("%label")',
  schedule: '("%label")',
  wait: '{"%label"}',
  branch: '{"%label"}',
  "trigger-event": '>"%label"]',
  checkpoint: '[["%label"]]',
  exit: '[["%label"]]',
  end: '((("%label")))',
};
const SHAPES_PLAIN: Record<GraphKind, string> = {
  trigger: "([%label])",
  email: "[%label]",
  inapp: "[%label]",
  connector: "[%label]",
  sleep: "(%label)",
  schedule: "(%label)",
  wait: "{%label}",
  branch: "{%label}",
  "trigger-event": ">%label]",
  checkpoint: "[[%label]]",
  exit: "[[%label]]",
  end: "(((%label)))",
};

/**
 * Characters that break a DOUBLE-QUOTED Mermaid node label (the full variant).
 * Because the label is wrapped in `"..."`, brackets/braces/parens are safe and
 * kept verbatim (so `days(3)` stays `days(3)`); we only encode:
 *   - `"`  → `#quot;`  (would close the quoted string)
 *   - `#`  → `#35;`    (`#` starts a Mermaid entity code; encode to keep literal)
 *   - `<`/`>` → HTML entities. The docs Mermaid component renders labels as
 *     HTML (htmlLabels + securityLevel loose), so a raw `<script>` would
 *     execute; entities decode safely there and are harmless on GitHub.
 *   - newlines → space, and `|` → `/` (guards the `-->|edge label|` syntax).
 */
const ESCAPE_MAP: Record<string, string> = {
  '"': "#quot;",
  "#": "#35;",
  "<": "&lt;",
  ">": "&gt;",
  "\n": " ",
  "\r": " ",
  "|": "/",
};

/** Escape a raw label for safe interpolation into a quoted Mermaid label. */
function escapeLabel(raw: string): string {
  let out = "";
  for (const ch of raw) {
    out += ESCAPE_MAP[ch] ?? ch;
  }
  // Collapse runs of whitespace and trim — Mermaid trims anyway, but this keeps
  // snapshots stable.
  return out.replace(/\s+/g, " ").trim();
}

/**
 * A short kind tag prepended to the label (no emoji). `tag: ` prefix in both
 * variants — bracketed tags would nest invalidly inside `[[...]]` shapes.
 */
function kindTag(kind: GraphKind): string {
  const tags: Partial<Record<GraphKind, string>> = {
    email: "send",
    inapp: "in-app",
    connector: "connector",
    schedule: "schedule",
    "trigger-event": "trigger",
    exit: "exit",
  };
  const tag = tags[kind];
  if (!tag) return "";
  return `${tag}: `;
}

/**
 * Sanitize a label for the "plain" variant: text-first renderers (terminal
 * ASCII) parse unquoted node text, so anything outside a conservative charset
 * becomes a hyphen/space. Also hard-caps length — terminal boxes are narrow.
 */
function plainLabel(raw: string, max = 44): string {
  const cleaned = raw
    .replace(/[—–]/g, "-")
    .replace(/['"`’]/g, "")
    .replace(/[^A-Za-z0-9 .,:_/=<>!-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

/** Compose the visible node text: optional kind tag + label + detail. */
function nodeText(node: GraphNode, variant: "full" | "plain"): string {
  if (variant === "plain") {
    // Terminal boxes stretch to the widest node — keep labels tight and trim
    // the detail harder (it's secondary).
    const parts: string[] = [kindTag(node.kind) + plainLabel(node.label)];
    if (node.detail) parts.push(plainLabel(node.detail, 24));
    return parts.join(" - ");
  }
  const parts: string[] = [kindTag(node.kind) + escapeLabel(node.label)];
  if (node.detail) {
    parts.push(escapeLabel(node.detail));
  }
  return parts.join(" — ");
}

/**
 * Render a {@link JourneyGraph} as a Mermaid `flowchart TD` string.
 *
 * Output is designed to render natively on GitHub/VSCode (fenced code blocks)
 * AND in the Fumadocs `<Mermaid>` component. Returns the diagram body WITHOUT
 * surrounding fences so callers control framing (stdout vs `--out` file).
 */
export function renderMermaid(
  graph: JourneyGraph,
  opts?: RenderMermaidOptions,
): string {
  const variant = opts?.variant ?? "full";
  const lines: string[] = [];

  if (variant === "full") {
    // Mermaid directive: the dark "crimzon" theme variables for the docs
    // component. The grammar is `%%{ init: { themeVariables: {...} } }%%` —
    // themeVariables MUST be wrapped in `init:` (a bare `%%{ themeVariables }%%`
    // is silently ignored). GitHub ignores directives and renders light; both
    // stay legible because the classDef fills carry their own contrast.
    lines.push(
      '%%{ init: { themeVariables: { primaryColor: "#0a0606", primaryTextColor: "#fff", lineColor: "#9ca3af", primaryBorderColor: "#f64838" } } }%%',
    );
  }
  lines.push("flowchart TD");

  if (variant === "full") {
    // Class definitions — one per kind present in the graph.
    const usedKinds = new Set(graph.nodes.map((n) => n.kind));
    for (const kind of usedKinds) {
      lines.push(`classDef ${className(kind)} ${CLASS_DEFS[kind]};`);
    }
    // Highlight class for simulator paths (§3.3); harmless when unused.
    lines.push("classDef hl stroke:#f64838,stroke-width:3px;");
  }

  // Node declarations. Stable iteration order = stable snapshots.
  const shapes = variant === "full" ? SHAPES_FULL : SHAPES_PLAIN;
  const byId = new Map<string, GraphNode>();
  for (const node of graph.nodes) {
    byId.set(node.id, node);
    const text = nodeText(node, variant);
    const shape = shapes[node.kind].replace("%label", text);
    const cls = variant === "full" ? `:::${className(node.kind)}` : "";
    lines.push(`  ${node.id}${shape}${cls}`);
  }

  // Edges. No dedup — the extractor never emits duplicate edges, and a
  // string-keyed Set would silently collapse edges that differ only by `kind`
  // (which isn't serialized into the line).
  const escapeEdge = variant === "plain" ? plainLabel : escapeLabel;
  for (const edge of graph.edges) {
    const label = edge.label ? `|${escapeEdge(edge.label)}|` : "";
    lines.push(`  ${edge.from} -->${label} ${edge.to}`);
  }

  // Apply highlight class to flagged nodes.
  if (variant === "full" && opts?.highlight?.length) {
    lines.push(`class ${opts.highlight.join(",")} hl;`);
  }

  return lines.join("\n");
}
