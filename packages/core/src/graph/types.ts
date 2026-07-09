/**
 * Pure, dependency-free types describing a journey's control-flow graph.
 *
 * A {@link JourneyGraph} is what every "visual journey graph" surface renders:
 * the CLI/docs source extractor produces a RICH graph (the full inside of
 * `run()`); the admin route falls back to a METADATA skeleton
 * ({@link sourceLevel} = "metadata") when no source-derived graph is available.
 *
 * Two renderers consume the same shape: `renderMermaid` (CLI/docs/route text
 * output) and the Studio ReactFlow canvas. Keeping it pure (no `typescript`,
 * no React) lets `@hogsend/core` stay the light, everywhere-importable schema
 * package.
 */

/** The kind of an authored control-flow step inside a journey `run()`. */
export type GraphKind =
  | "trigger"
  | "email"
  | "inapp"
  | "connector"
  | "sleep"
  | "schedule"
  | "wait"
  | "branch"
  | "trigger-event"
  | "checkpoint"
  | "exit"
  | "end";

/** A node in the graph — one authored step (or the journey trigger/exit). */
export interface GraphNode {
  /** Stable node id, unique within the graph (e.g. "n1", "n2"). */
  id: string;
  kind: GraphKind;
  /** Human label — the subject line, event name, checkpoint label, etc. */
  label: string;
  /** Secondary detail (template key, connector/action, duration text). */
  detail?: string;
  /**
   * For `email` nodes: the template reference AS AUTHORED in source, e.g.
   * `Templates.CHURN_PAYMENT_FAILED` or a bare `"welcome"` literal. Preserved
   * verbatim so the UI can show what the developer wrote.
   */
  templateRef?: string;
  /**
   * For `email` nodes: the RESOLVED template key (e.g. `churn-payment-failed`),
   * when the extractor could follow `templateRef` to a literal — string
   * literals resolve trivially; `Templates.X` is resolved by following the
   * import to the constants module. `undefined` when the reference is dynamic
   * (runtime-computed) or otherwise unresolvable — the UI must say so honestly
   * rather than guess. This is the reliable join key to `email_sends.templateKey`.
   */
  templateKey?: string;
  /** 1-based source line of the originating statement (rich graphs only). */
  sourceLine?: number;
  /**
   * Key used to join a node to live counts. For checkpoints this is the
   * checkpoint label; the admin route groups `journeyStates.currentNodeId`
   * (the last checkpoint label) and attaches counts by matching this key.
   */
  countKey?: string;
}

/** How `kind` values classify an edge's semantic role. */
export type GraphEdgeKind = "main" | "yes" | "no" | "fired" | "timeout";

/** A directed edge between two nodes. */
export interface GraphEdge {
  from: string;
  to: string;
  /** Edge caption ("yes", "no", "fired", "timed out"). */
  label?: string;
  kind?: GraphEdgeKind;
}

/**
 * Whether this graph was extracted from authored source ("rich") or synthesized
 * from {@link JourneyMeta} alone ("metadata"). Surfaced in the admin route and
 * Studio so the UI can be honest about fidelity.
 */
export type GraphSourceLevel = "rich" | "metadata";

/** The full control-flow graph for one journey. */
export interface JourneyGraph {
  journeyId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  sourceLevel: GraphSourceLevel;
  /**
   * Present when the extractor skipped statements it couldn't classify (loops,
   * dynamic dispatch, unknown calls). Renders as a footnote so readers know the
   * graph is best-effort.
   */
  disclaimer?: string;
  /**
   * Path of the authored `.ts` file this graph was extracted from, relative to
   * the project root the extractor ran in (rich graphs only). Studio renders it
   * as a `file:line` code pointer; the admin route re-hashes it (when present
   * on disk) to detect a stale manifest.
   */
  sourceFile?: string;
  /**
   * SHA-256 hex digest of the source text the graph was extracted from (rich
   * graphs only). Compared against the on-disk file to flag stale manifests.
   */
  sourceHash?: string;
}

/** Options accepted by `renderMermaid`. */
export interface RenderMermaidOptions {
  /**
   * Node ids to highlight (e.g. the path taken by a simulator). Emits a
   * `class … hl;` so the renderer can stroke them in the accent color.
   */
  highlight?: string[];
  /**
   * "full" (default) emits the theme directive + classDefs for browser
   * renderers (docs site, GitHub, mermaid.live). "plain" emits bare
   * `flowchart TD` with aggressively sanitized labels — no directive, no
   * classDefs — for text-first renderers (terminal ASCII) whose parsers choke
   * on quoted labels, bracketed tags, and typographic punctuation.
   */
  variant?: "full" | "plain";
}
