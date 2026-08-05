import type { JSX } from "react";
import { TagPill } from "@/components/ds/badge";
import type { StackRow } from "@/src/services/orgs";

/**
 * A stack's lifecycle status, as a chip. The label is the status verbatim —
 * the dashboard and the state machine (`StackService.transition`) must never
 * disagree about what a stack IS, so nothing here renames or groups a status.
 *
 * Tone is the only interpretation: green once it is serving, amber while it is
 * moving or parked, red when it stopped on an error.
 */

type StackStatus = StackRow["status"];

const TONE: Record<StackStatus, "neutral" | "accent" | "good" | "caution"> = {
  // Nothing has been asked for yet (PRD 15): it is a state, not a stall.
  deferred: "neutral",
  requested: "neutral",
  provisioning: "caution",
  running: "good",
  publishing: "caution",
  suspended: "caution",
  destroying: "caution",
  destroyed: "neutral",
  error: "accent",
};

export function StackStatusChip({
  status,
}: {
  /** null when the environment has no stack row at all. */
  status: StackStatus | null;
}): JSX.Element {
  if (!status) return <TagPill tone="neutral">no stack</TagPill>;
  return <TagPill tone={TONE[status]}>{status}</TagPill>;
}
