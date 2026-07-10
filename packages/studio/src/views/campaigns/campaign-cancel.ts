import type { Campaign, CampaignStatus } from "@/lib/admin-api";

/** In-flight (non-terminal) statuses a cancel is allowed against. */
export const CANCELABLE: ReadonlySet<CampaignStatus> = new Set<CampaignStatus>([
  "scheduled",
  "queued",
  "sending",
  "waiting",
]);

/** Confirm-copy that matches the cancel semantics for the target's state. */
export function cancelDescription(c: Campaign): string {
  if (c.status === "sending") {
    return `"${c.name}" will stop at the next chunk of 100 recipients. Emails already dispatched cannot be recalled.`;
  }
  if (c.status === "waiting") {
    return `"${c.name}" is between waves — its remaining steps will not send. Emails already dispatched cannot be recalled.`;
  }
  return `"${c.name}" is ${c.status} and will not be sent.`;
}
