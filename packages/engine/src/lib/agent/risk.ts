import type { TestModeState } from "../domain-status.js";

/**
 * The risk tier of an agent tool. Drives the confirm-card severity in Studio AND
 * (advisory) the system prompt's per-tool caution. The HITL chokepoint is
 * UNCONDITIONAL regardless of tier — tier is presentation/observability metadata,
 * not the gate. `read` tools auto-run (no proposal); every non-`read` tier mints
 * a proposal and is performed ONLY by POST /v1/admin/agent/confirm.
 */
export type Tier = "read" | "write_safe" | "write_external" | "destructive";

/**
 * Static per-tool tier registry. Unknown tool ⇒ treated as `destructive`
 * (fail-closed: an unregistered write must get the loudest confirm).
 */
const TIER_REGISTRY: Record<string, Tier> = {
  // reads — auto-run
  list_journeys: "read",
  list_buckets: "read",
  overview_stats: "read",
  query_events: "read",
  find_contacts: "read",
  get_contact: "read",
  get_contact_timeline: "read",
  list_sends: "read",
  build_audience: "read",
  // writes — mint a proposal
  upsert_contact: "write_safe",
  update_contact: "write_safe",
  subscribe_list: "write_safe",
  unsubscribe_list: "write_safe",
  enroll_in_journey: "write_external",
  fire_event: "write_external",
  send_transactional_email: "write_external",
  send_campaign: "write_external",
  delete_contact: "destructive",
};

export function baseTier(tool: string): Tier {
  return TIER_REGISTRY[tool] ?? "destructive";
}

export function isReadTool(tool: string): boolean {
  return baseTier(tool) === "read";
}

/**
 * The tier AS IT APPLIES RIGHT NOW, given live test-mode. When test mode is
 * active every send is redirected to the test inbox and never reaches a real
 * recipient, so the two SEND tools relax from `write_external` to `write_safe`
 * for the confirm-card severity. `fire_event` is NOT relaxed — firing an event
 * still triggers journeys/buckets (an internal side effect test-mode doesn't
 * mute). `destructive` is never relaxed. Computed off the SYNC cache
 * (`domainStatus.testModeCached()`), so it never awaits.
 */
export function effectiveTier(
  tool: string,
  opts: { testMode: TestModeState },
): Tier {
  const base = baseTier(tool);
  if (
    opts.testMode.active &&
    (tool === "send_transactional_email" || tool === "send_campaign")
  ) {
    return "write_safe";
  }
  return base;
}
