import { ChevronDown, Plug, Search } from "lucide-react";
import {
  PICKER_INPUT_CLASS,
  PickerClearButton,
  usePicker,
} from "@/components/ui/picker";
import type { SourceEntry } from "@/lib/admin-api";
import { formatDateTime, formatNumber, formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Chip copy per source kind for the detail pane. */
const KIND_LABEL: Record<SourceEntry["kind"], string> = {
  connector: "Registered connector",
  builtin: "Engine origin",
  observed: "Observed source",
};

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="eyebrow text-[10px] text-white/35">{label}</p>
      <p className="mt-0.5 text-sm text-white/80">{value}</p>
    </div>
  );
}

/**
 * The source selector — same two-pane shape as the event picker: filtered
 * list left (plug icon on registered connectors), a detail pane right with
 * what the source IS (connector name / engine-origin explanation), volume,
 * and first/last seen. Sources are an open vocabulary like event names, so
 * `allowCustom` keeps a raw value usable; a stored value missing from the
 * vocabulary still round-trips.
 */
export function SourcePicker({
  ariaLabel,
  value,
  sources,
  placeholder,
  onChange,
  className,
  allowClear = false,
  allowCustom = false,
}: {
  ariaLabel: string;
  value: string;
  sources: SourceEntry[];
  placeholder: string;
  onChange: (next: string) => void;
  className?: string;
  allowClear?: boolean;
  allowCustom?: boolean;
}) {
  const picker = usePicker();

  const known = sources.some((s) => s.name === value);
  const all =
    !known && value !== ""
      ? [
          {
            name: value,
            occurrences: 0,
            firstSeenAt: null,
            lastSeenAt: null,
            kind: "observed" as const,
            label: null,
          },
          ...sources,
        ]
      : sources;
  const q = picker.query.trim().toLowerCase();
  const filtered = q
    ? all.filter((s) => s.name.toLowerCase().includes(q))
    : all;
  const trimmed = picker.query.trim();
  const custom =
    allowCustom && trimmed !== "" && !all.some((s) => s.name === trimmed);
  const rows: Array<SourceEntry & { isNew?: boolean }> = custom
    ? [
        {
          name: trimmed,
          occurrences: 0,
          firstSeenAt: null,
          lastSeenAt: null,
          kind: "observed" as const,
          label: null,
          isNew: true,
        },
        ...filtered,
      ]
    : filtered;
  const detail = rows[picker.active] ?? rows[0];

  function pick(next: string) {
    onChange(next);
    picker.close();
  }

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
              {picker.query === "" ? "Type to search sources" : picker.query}
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
                rows.map((s, i) => (
                  <button
                    key={s.name}
                    type="button"
                    role="option"
                    aria-selected={s.name === value}
                    data-index={i}
                    // mousedown so selection beats the input's blur.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      pick(s.name);
                    }}
                    onMouseEnter={() => picker.setActive(i)}
                    className={cn(
                      "flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-xs",
                      i === picker.active
                        ? "bg-white/[0.06] text-white"
                        : "text-white/75",
                      s.name === value && !s.isNew ? "text-accent" : "",
                      s.isNew ? "italic text-white/60" : "",
                    )}
                  >
                    {s.kind === "connector" ? (
                      <Plug className="h-3 w-3 shrink-0 text-accent/70" />
                    ) : (
                      <span className="w-3 shrink-0" />
                    )}
                    <span className="truncate">
                      {s.isNew ? `Use "${s.name}"` : s.name}
                    </span>
                  </button>
                ))
              )}
            </div>

            <div className="w-1/2 space-y-3 border-l border-white/[0.06] p-4">
              {detail?.isNew ? (
                <>
                  <p className="break-all font-mono text-sm text-white">
                    {detail.name}
                  </p>
                  <p className="text-xs text-white/40">
                    New source — nothing has arrived through it yet. Sources are
                    an open vocabulary, so any value is valid.
                  </p>
                </>
              ) : detail ? (
                <>
                  <p className="break-all font-mono text-sm text-white">
                    {detail.name}
                  </p>
                  <span
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]",
                      detail.kind === "connector"
                        ? "border-accent/30 bg-accent-tint text-white/85"
                        : "border-white/[0.12] bg-white/[0.03] text-white/60",
                    )}
                  >
                    {detail.kind === "connector" ? (
                      <Plug className="h-2.5 w-2.5" />
                    ) : null}
                    {KIND_LABEL[detail.kind]}
                  </span>
                  {detail.label ? (
                    <p className="text-xs text-white/50">{detail.label}</p>
                  ) : (
                    <p className="text-xs text-white/40">
                      Stamped by whatever ingests through it — not a registered
                      connector or engine origin.
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
                      label="Events"
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
                  No source highlighted yet.
                </p>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
