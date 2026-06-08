import type { env as engineEnv } from "../../env.js";
import type { DefinedDestination } from "../define-destination.js";
import { posthogDestination } from "./posthog.js";
import { segmentDestination } from "./segment.js";
import { slackDestination } from "./slack.js";
import { webhookDestination } from "./webhook.js";

export { posthogDestination } from "./posthog.js";
export { segmentDestination } from "./segment.js";
export { slackDestination } from "./slack.js";
export { webhookDestination } from "./webhook.js";

/**
 * All shipped destination presets, keyed by their `kind` id. The id is also the
 * value stored in `webhook_endpoints.kind`: `PRESET_DESTINATIONS.posthog`
 * delivers every endpoint with `kind = "posthog"`.
 */
export const PRESET_DESTINATIONS = {
  webhook: webhookDestination,
  posthog: posthogDestination,
  segment: segmentDestination,
  slack: slackDestination,
} satisfies Record<string, DefinedDestination>;

/** The stable id of a shipped destination preset. */
export type DestinationPresetId = keyof typeof PRESET_DESTINATIONS;

/**
 * The preset ids that are ALWAYS registered, regardless of
 * `ENABLED_DESTINATION_PRESETS`:
 *  - `webhook` — the default signed POST every existing subscriber receives
 *    (turning it off would silently break all outbound webhooks).
 *  - `posthog` — the auto-seeded `ENABLE_POSTHOG_DESTINATION` endpoint resolves
 *    here; it must stay deliverable even when the env override names only other
 *    presets.
 */
const ALWAYS_ON: readonly DestinationPresetId[] = ["webhook", "posthog"];

/** The slice of the validated env `destinationsFromEnv` reads. */
type DestinationPresetEnv = Pick<
  typeof engineEnv,
  "ENABLED_DESTINATION_PRESETS"
>;

/**
 * Resolve which destination PRESETS to register into the process registry from
 * the validated env (mirrors `presetsFromEnv` for inbound sources).
 *
 * Resolution order:
 *  1. `ENABLED_DESTINATION_PRESETS === "none"` → ONLY the always-on set
 *     (`webhook` + `posthog`). "none" disables the OPTIONAL presets, never the
 *     no-regression ones.
 *  2. `ENABLED_DESTINATION_PRESETS` is a csv of ids → exactly those (unknown ids
 *     ignored), UNIONED with the always-on set.
 *  3. `ENABLED_DESTINATION_PRESETS === "*"` → every preset.
 *  4. absent → the DEFAULT set (the always-on set only).
 *
 * Unlike inbound presets, destinations carry NO env secret to gate on — their
 * credentials live per-endpoint in `webhook_endpoints.config`. The env only
 * decides which transforms are RESOLVABLE; an endpoint with a `kind` whose
 * transform is not registered fails its delivery as a config error (DLQ), which
 * is the right signal that the preset was not enabled.
 */
export function destinationsFromEnv(
  env: DestinationPresetEnv,
): DefinedDestination[] {
  const override = env.ENABLED_DESTINATION_PRESETS?.trim();

  const byId = (id: DestinationPresetId): DefinedDestination =>
    PRESET_DESTINATIONS[id];

  // (3) "*" — every preset.
  if (override === "*") {
    return Object.values(PRESET_DESTINATIONS);
  }

  // (2) explicit csv allow-list (anything other than "*"/"none"/empty), UNIONed
  // with the always-on set so webhook/posthog can never be dropped.
  if (override && override !== "none") {
    const ids = new Set<string>([
      ...ALWAYS_ON,
      ...override
        .split(",")
        .map((id) => id.trim().toLowerCase())
        .filter((id) => id.length > 0),
    ]);
    return (Object.keys(PRESET_DESTINATIONS) as DestinationPresetId[])
      .filter((id) => ids.has(id))
      .map(byId);
  }

  // (1) "none" and (4) absent → the always-on set only.
  return ALWAYS_ON.map(byId);
}
