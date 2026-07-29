import type { JSX } from "react";
import { TagPill } from "@/components/ds/badge";
import type { BuildStatus } from "@/src/services/builds";

/**
 * A build's status, as a chip.
 *
 * The twin of `StackStatusChip`, and it follows the same law: the label is the
 * status verbatim, so the dashboard and `BuildService.transition` cannot come to
 * disagree about what a build IS. Tone is the only interpretation — green when
 * it shipped, red when it stopped, amber for every stage still in flight.
 */

const TONE: Record<BuildStatus, "neutral" | "accent" | "good" | "caution"> = {
  queued: "neutral",
  building: "caution",
  preflight: "caution",
  pushing: "caution",
  deploying: "caution",
  succeeded: "good",
  failed: "accent",
};

export function BuildStatusChip({
  status,
}: {
  status: BuildStatus;
}): JSX.Element {
  return <TagPill tone={TONE[status]}>{status}</TagPill>;
}

/**
 * The first 12 characters of `sha256:…` — enough to identify an image in a
 * conversation, short enough to sit in a table row. The full digest is on the
 * build's own page.
 */
export function shortDigest(digest: string | null): string | null {
  if (!digest) return null;
  const [algorithm, hex] = digest.split(":");
  if (!hex) return digest.slice(0, 12);
  return `${algorithm}:${hex.slice(0, 12)}`;
}
