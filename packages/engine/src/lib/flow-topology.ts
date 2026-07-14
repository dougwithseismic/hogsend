/**
 * Flow-map topology vocabulary — the shared shape every phase of the control
 * room agrees on.
 *
 * A flow node is one place a contact can *be* in the growth machine (a
 * surface they touched, a journey they're enrolled in, a funnel stage they've
 * reached); a tier is the lifecycle column it lives in. P1 only mints
 * `surface` nodes from raw event-name prefixes — the registry-backed
 * classifier (journeys, funnel stages, `defineSurface`) lands in P2/P3, and
 * will produce the other kinds against these same types.
 */

/** Lifecycle column a node is drawn in — the flow map's x-axis. */
export type SurfaceTier =
  | "acquisition"
  | "activation"
  | "retention"
  | "revenue";

/** What a node *is* — decides its icon + drill-down in Studio. */
export type FlowNodeKind = "surface" | "journey" | "funnelStage" | "builtin";

export interface FlowNode {
  id: string;
  kind: FlowNodeKind;
  name: string;
  tier: SurfaceTier;
}
