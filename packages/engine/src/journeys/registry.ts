import { JourneyRegistry } from "@hogsend/core/registry";
import type { DefinedJourney } from "./define-journey.js";
import { setJourneyRegistry } from "./registry-singleton.js";

/**
 * Parse the `ENABLED_JOURNEYS` filter. Returns `"*"` to enable all journeys, or
 * a `Set` of journey ids to enable. Only an empty/undefined value or a literal
 * `"*"` (after trim) means all; a whitespace-only value (e.g. `"   "`) falls
 * through to an empty `Set` (enables nothing).
 */
export function parseEnabledFilter(filter?: string): "*" | Set<string> {
  if (!filter || filter.trim() === "*") return "*";
  return new Set(
    filter
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/**
 * Iterative Levenshtein edit distance (two-row). Private helper backing the
 * "did you mean" suggestion in {@link resolveEnabledFilter}; there is no shared
 * edit-distance utility in the repo.
 */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  // `?? 0` guards are unreachable (indices stay in-bounds) but satisfy
  // `noUncheckedIndexedAccess`.
  let prev: number[] = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const curr: number[] = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        (prev[j] ?? 0) + 1, // deletion
        (curr[j - 1] ?? 0) + 1, // insertion
        (prev[j - 1] ?? 0) + cost, // substitution
      );
    }
    prev = curr;
  }
  return prev[n] ?? 0;
}

/**
 * Closest known id to `id` within a small edit-distance threshold, or
 * `undefined` when nothing is close enough to be a plausible typo. The
 * threshold scales with id length so short ids don't over-suggest.
 */
function closestKnownId(id: string, knownIds: string[]): string | undefined {
  const threshold = Math.max(2, Math.floor(id.length / 3));
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const known of knownIds) {
    const distance = levenshtein(id, known);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = known;
    }
  }
  return best !== undefined && bestDistance <= threshold ? best : undefined;
}

/**
 * Resolve AND validate the `ENABLED_JOURNEYS` filter against the closed set of
 * known journey ids. `ENABLED_JOURNEYS` is operator config over a fully-known
 * universe (`journeys.map(j => j.meta.id)` plus `extraKnownIds`), so a filter id
 * that matches no journey is a typo or a stale reference to a renamed/removed
 * journey — silently dropping it means the intended journey never registers and
 * never fires in prod. Fail loud instead (the analog of the EMAIL_PROVIDER /
 * ANALYTICS_PROVIDER boot throws):
 *
 * - `"*"` / empty → `"*"` (enable all); no validation, no throw.
 * - **Empty top-level `journeys[]`** → no validation, no throw. `ENABLED_JOURNEYS`
 *   restricts the top-level journeys; a bucket-only client injects none here
 *   (its bucket-reaction journeys are registered separately, gated by
 *   `ENABLED_BUCKETS`), so there is nothing this filter can validate.
 * - Otherwise validate every filter id against ALL known ids — the top-level
 *   journey ids (INCLUDING `meta.enabled: false` ones, since a disabled journey
 *   is a known id, not a typo) PLUS `extraKnownIds` (the bucket-reaction journey
 *   ids `bucket-<id>-on-<kind>`, which ARE registered journeys even though they
 *   bypass this filter). Unknown ids throw a single error naming each one (with a
 *   `(did you mean "…"?)` when a close known id exists) plus the known-id list.
 * - An empty `Set` (e.g. filter `","`) has nothing to validate → no throw
 *   (enables nothing; pre-existing behavior).
 *
 * @param extraKnownIds additional valid ids not present in `journeys[]` (e.g.
 *   bucket-reaction journey ids) — accepted in the filter without a throw.
 *
 * Pure/synchronous; both boot paths ({@link buildJourneyRegistry} at container
 * boot, {@link selectJourneyTasks} at worker boot) route through it.
 */
export function resolveEnabledFilter(
  journeys: DefinedJourney[],
  enabledFilter?: string,
  extraKnownIds?: string[],
): "*" | Set<string> {
  const enabled = parseEnabledFilter(enabledFilter);
  if (enabled === "*") return enabled;
  // Nothing to validate when no top-level journeys were injected.
  if (journeys.length === 0) return enabled;

  const allKnown = [
    ...journeys.map((j) => j.meta.id),
    ...(extraKnownIds ?? []),
  ];
  const knownSet = new Set(allKnown);
  const unknown = [...enabled].filter((id) => !knownSet.has(id));
  if (unknown.length === 0) return enabled;

  const details = unknown
    .map((id) => {
      const suggestion = closestKnownId(id, allKnown);
      return suggestion ? `"${id}" (did you mean "${suggestion}"?)` : `"${id}"`;
    })
    .join(", ");
  const known =
    knownSet.size > 0
      ? [...knownSet].map((id) => `"${id}"`).join(", ")
      : "(none registered)";

  throw new Error(
    `ENABLED_JOURNEYS references ${
      unknown.length === 1 ? "an unknown journey id" : "unknown journey ids"
    }: ${details}. Known journey ids: ${known}.`,
  );
}

/**
 * Build a {@link JourneyRegistry} from an injected array of journeys, applying
 * the enabled filter, and install it as the process singleton (so durable tasks
 * can resolve it). Returns the registry. Throws (via
 * {@link resolveEnabledFilter}) when the filter references an unknown journey.
 *
 * @param extraKnownIds additional valid ids (e.g. bucket-reaction journey ids)
 *   accepted in the filter without a throw — see {@link resolveEnabledFilter}.
 */
export function buildJourneyRegistry(
  journeys: DefinedJourney[],
  enabledFilter?: string,
  extraKnownIds?: string[],
): JourneyRegistry {
  const registry = new JourneyRegistry();
  const enabled = resolveEnabledFilter(journeys, enabledFilter, extraKnownIds);

  for (const journey of journeys) {
    if (enabled === "*" || enabled.has(journey.meta.id)) {
      registry.register(journey.meta);
    }
  }

  setJourneyRegistry(registry);
  return registry;
}

/**
 * Select the Hatchet durable tasks for the enabled journeys from an injected
 * array of journeys. Throws (via {@link resolveEnabledFilter}) when the filter
 * references an unknown journey.
 *
 * @param extraKnownIds additional valid ids (e.g. bucket-reaction journey ids)
 *   accepted in the filter without a throw — see {@link resolveEnabledFilter}.
 */
export function selectJourneyTasks(
  journeys: DefinedJourney[],
  enabledFilter?: string,
  extraKnownIds?: string[],
) {
  const enabled = resolveEnabledFilter(journeys, enabledFilter, extraKnownIds);
  return journeys
    .filter((j) => enabled === "*" || enabled.has(j.meta.id))
    .map((j) => j.task);
}
