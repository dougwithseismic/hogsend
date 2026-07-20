import type { ComboboxOption } from "@/components/ui/combobox";
import type { TargetingEventName } from "./admin-api";

/**
 * Event vocabulary → combobox options, ranked so signal beats residue:
 * journey-trigger events first, then by observed volume. The hint makes the
 * ranking legible — "trigger" for declared events, ×N for observed ones.
 */
export function eventOptions(events: TargetingEventName[]): ComboboxOption[] {
  return [...events]
    .sort(
      (a, b) =>
        Number(b.usedBy.length > 0) - Number(a.usedBy.length > 0) ||
        b.occurrences - a.occurrences ||
        a.name.localeCompare(b.name),
    )
    .map((ev) => ({
      value: ev.name,
      label: ev.name,
      hint:
        ev.usedBy.length > 0
          ? "trigger"
          : ev.occurrences > 0
            ? `×${ev.occurrences}`
            : undefined,
    }));
}
