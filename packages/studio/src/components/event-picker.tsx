import { ChevronDown, Search, Zap } from "lucide-react";
import {
  PICKER_INPUT_CLASS,
  PickerClearButton,
  usePicker,
} from "@/components/ui/picker";
import type { TargetingEventName, TargetingIdName } from "@/lib/admin-api";
import { formatDateTime, formatNumber, formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";

/** How many filtered events to render before asking for a narrower query. */
const MAX_VISIBLE = 100;

/** Signal first: journey/blueprint-trigger events, then by observed volume. */
function rankEvents(events: TargetingEventName[]): TargetingEventName[] {
  return [...events].sort(
    (a, b) =>
      Number(b.usedBy.length > 0) - Number(a.usedBy.length > 0) ||
      b.occurrences - a.occurrences ||
      a.name.localeCompare(b.name),
  );
}

/** "journey:<id>" → the journey's display name; blueprints pass through. */
function usedByLabel(ref: string, journeys: TargetingIdName[]): string {
  const journeyId = ref.startsWith("journey:") ? ref.slice(8) : null;
  if (journeyId) {
    return journeys.find((j) => j.id === journeyId)?.name ?? journeyId;
  }
  return ref;
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="eyebrow text-[10px] text-white/35">{label}</p>
      <p className="mt-0.5 text-sm text-white/80">{value}</p>
    </div>
  );
}

/**
 * The event selector — a searchable list with a detail pane
 * for the highlighted event (first/last seen, volume, which journeys trigger
 * on it), so picking an anchor or condition event is informed, not a guess
 * over raw names. Events are an open vocabulary: the list is observed +
 * declared usage, ranked triggers-first so residue sinks. A stored value
 * missing from the catalog still round-trips.
 */
export function EventPicker({
  ariaLabel,
  value,
  events,
  journeys = [],
  placeholder,
  onChange,
  className,
  allowClear = false,
  allowCustom = false,
}: {
  ariaLabel: string;
  value: string;
  events: TargetingEventName[];
  /** Resolves `usedBy` journey ids to display names in the detail pane. */
  journeys?: TargetingIdName[];
  placeholder: string;
  onChange: (next: string) => void;
  className?: string;
  allowClear?: boolean;
  /** Open-vocabulary mode: offer a `Use "<typed>"` row for unseen names. */
  allowCustom?: boolean;
}) {
  const picker = usePicker();

  const known = events.some((ev) => ev.name === value);
  const all = rankEvents(
    !known && value !== ""
      ? [
          {
            name: value,
            occurrences: 0,
            firstSeenAt: null,
            lastSeenAt: null,
            usedBy: [],
          },
          ...events,
        ]
      : events,
  );
  const q = picker.query.trim().toLowerCase();
  const filtered = q
    ? all.filter((ev) => ev.name.toLowerCase().includes(q))
    : all;
  const visible = filtered.slice(0, MAX_VISIBLE);
  const trimmed = picker.query.trim();
  const custom =
    allowCustom && trimmed !== "" && !all.some((ev) => ev.name === trimmed);
  const rows: Array<TargetingEventName & { isNew?: boolean }> = custom
    ? [
        {
          name: trimmed,
          occurrences: 0,
          firstSeenAt: null,
          lastSeenAt: null,
          usedBy: [],
          isNew: true,
        },
        ...visible,
      ]
    : visible;
  const detail = rows[picker.active] ?? rows[0];

  function pick(next: string) {
    onChange(next);
    picker.close();
  }

  const triggers = detail?.usedBy ?? [];

  return (
    <div ref={picker.rootRef} className={cn("relative", className)}>
      <input
        ref={picker.inputRef}
        aria-label={ariaLabel}
        placeholder={placeholder}
        value={picker.open ? picker.query : value}
        onKeyDown={picker.keyDown(rows.length, (i) => {
          const hit = rows[i];
          if (hit) pick(hit.name);
        })}
        className={cn(
          PICKER_INPUT_CLASS,
          "font-mono text-xs placeholder:font-sans placeholder:text-sm",
        )}
        {...picker.inputProps}
      />
      {allowClear && value !== "" ? (
        <PickerClearButton
          label={`Clear ${ariaLabel}`}
          onClear={() => pick("")}
        />
      ) : null}
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-white/40" />

      {picker.open ? (
        <div className="absolute z-30 mt-1 w-[40rem] max-w-[calc(100vw-3rem)] overflow-hidden rounded-md border border-white/[0.1] bg-[#141010] shadow-xl">
          <div className="relative border-b border-white/[0.06]">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-white/35" />
            <p className="py-2 pl-9 pr-3 text-sm text-white/40">
              {picker.query === "" ? "Type to search events" : picker.query}
            </p>
          </div>
          <div className="flex">
            <div
              ref={picker.listRef}
              role="listbox"
              className="max-h-80 w-1/2 overflow-y-auto py-1"
            >
              {rows.length === 0 ? (
                <p className="px-3 py-2 text-sm text-white/40">No matches</p>
              ) : (
                rows.map((ev, i) => (
                  <button
                    key={ev.name}
                    type="button"
                    role="option"
                    aria-selected={ev.name === value}
                    data-index={i}
                    // mousedown so selection beats the input's blur.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      pick(ev.name);
                    }}
                    onMouseEnter={() => picker.setActive(i)}
                    className={cn(
                      "flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-xs",
                      i === picker.active
                        ? "bg-white/[0.06] text-white"
                        : "text-white/75",
                      ev.name === value && !ev.isNew ? "text-accent" : "",
                      ev.isNew ? "italic text-white/60" : "",
                    )}
                  >
                    {ev.usedBy.length > 0 ? (
                      <Zap className="h-3 w-3 shrink-0 text-accent/70" />
                    ) : (
                      <span className="w-3 shrink-0" />
                    )}
                    <span className="truncate">
                      {ev.isNew ? `Use "${ev.name}"` : ev.name}
                    </span>
                  </button>
                ))
              )}
              {filtered.length > MAX_VISIBLE ? (
                <p className="px-3 py-1.5 text-xs text-white/35">
                  +{filtered.length - MAX_VISIBLE} more — keep typing
                </p>
              ) : null}
            </div>

            <div className="w-1/2 space-y-3 border-l border-white/[0.06] p-4">
              {detail?.isNew ? (
                <>
                  <p className="break-all font-mono text-sm text-white">
                    {detail.name}
                  </p>
                  <p className="text-xs text-white/40">
                    New event name — nothing has fired it yet. Event names are
                    an open vocabulary, so any name is valid.
                  </p>
                </>
              ) : detail ? (
                <>
                  <p className="break-all font-mono text-sm text-white">
                    {detail.name}
                  </p>
                  {triggers.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {triggers.slice(0, 4).map((ref) => (
                        <span
                          key={ref}
                          className="inline-flex items-center gap-1 rounded-full border border-accent/30 bg-accent-tint px-2 py-0.5 text-[11px] text-white/85"
                        >
                          <Zap className="h-2.5 w-2.5" />
                          {usedByLabel(ref, journeys)}
                        </span>
                      ))}
                      {triggers.length > 4 ? (
                        <span className="text-[11px] text-white/40">
                          +{triggers.length - 4} more
                        </span>
                      ) : null}
                    </div>
                  ) : (
                    <p className="text-xs text-white/40">
                      Observed event — no journey triggers on it.
                    </p>
                  )}
                  <div className="grid grid-cols-2 gap-3 border-t border-white/[0.06] pt-3">
                    <DetailRow
                      label="First seen"
                      value={
                        detail.firstSeenAt
                          ? formatRelative(detail.firstSeenAt)
                          : "never"
                      }
                    />
                    <DetailRow
                      label="Last seen"
                      value={
                        detail.lastSeenAt
                          ? formatRelative(detail.lastSeenAt)
                          : "never"
                      }
                    />
                    <DetailRow
                      label="Occurrences"
                      value={formatNumber(detail.occurrences)}
                    />
                  </div>
                  {detail.lastSeenAt ? (
                    <p className="text-[11px] text-white/30">
                      Last at {formatDateTime(detail.lastSeenAt)}
                    </p>
                  ) : null}
                </>
              ) : (
                <p className="text-sm text-white/40">
                  No event highlighted yet.
                </p>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
