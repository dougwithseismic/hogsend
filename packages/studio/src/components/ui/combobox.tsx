import { ChevronDown } from "lucide-react";
import {
  PICKER_INPUT_CLASS,
  PickerClearButton,
  usePicker,
} from "@/components/ui/picker";
import { cn } from "@/lib/utils";

export type ComboboxOption = {
  value: string;
  label: string;
  /** Dimmed right-aligned annotation (an occurrence count, a badge). */
  hint?: string;
};

/** How many filtered options to render before asking for a narrower query. */
const MAX_VISIBLE = 100;

/**
 * A searchable single-select over a bounded catalog: the input is the query,
 * the dropdown is the filtered option list. Replaces `IdSelect` wherever the
 * list is long enough that scanning beats nobody (event vocabularies, journey
 * registries, template catalogs). Same round-trip guarantee: a stored value
 * missing from the catalog is still shown and re-selectable. `allowClear`
 * adds an × that resets to "" — the "All" state for filter usage.
 */
export function Combobox({
  ariaLabel,
  value,
  options,
  placeholder,
  onChange,
  className,
  allowClear = false,
  allowCustom = false,
}: {
  ariaLabel: string;
  value: string;
  options: ComboboxOption[];
  placeholder: string;
  onChange: (next: string) => void;
  className?: string;
  allowClear?: boolean;
  /** Open-vocabulary mode: offer a `Use "<typed>"` row for unknown values. */
  allowCustom?: boolean;
}) {
  const picker = usePicker();

  const selected = options.find((o) => o.value === value);
  const all =
    !selected && value !== "" ? [{ value, label: value }, ...options] : options;
  const q = picker.query.trim().toLowerCase();
  const filtered = q
    ? all.filter(
        (o) =>
          o.label.toLowerCase().includes(q) ||
          o.value.toLowerCase().includes(q),
      )
    : all;
  const visible = filtered.slice(0, MAX_VISIBLE);
  const trimmed = picker.query.trim();
  const custom =
    allowCustom && trimmed !== "" && !all.some((o) => o.value === trimmed);
  const rows: Array<ComboboxOption & { isCustom?: boolean }> = custom
    ? [
        { value: trimmed, label: `Use "${trimmed}"`, isCustom: true },
        ...visible,
      ]
    : visible;

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
        value={picker.open ? picker.query : (selected?.label ?? value)}
        onKeyDown={picker.keyDown(rows.length, (i) => {
          const hit = rows[i];
          if (hit) pick(hit.value);
        })}
        className={PICKER_INPUT_CLASS}
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
        <div
          ref={picker.listRef}
          role="listbox"
          className="absolute z-30 mt-1 max-h-72 w-full min-w-56 overflow-y-auto rounded-md border border-white/[0.1] bg-[#141010] py-1 shadow-xl"
        >
          {rows.length === 0 ? (
            <p className="px-3 py-2 text-sm text-white/40">No matches</p>
          ) : (
            rows.map((o, i) => (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={o.value === value}
                data-index={i}
                // mousedown so selection beats the input's blur.
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(o.value);
                }}
                onMouseEnter={() => picker.setActive(i)}
                className={cn(
                  "flex w-full items-baseline justify-between gap-3 px-3 py-1.5 text-left text-sm",
                  i === picker.active
                    ? "bg-white/[0.06] text-white"
                    : "text-white/80",
                  o.value === value && !o.isCustom ? "text-accent" : "",
                  o.isCustom ? "italic text-white/60" : "",
                )}
              >
                <span className="truncate">{o.label}</span>
                {o.hint ? (
                  <span className="shrink-0 text-xs text-white/35">
                    {o.hint}
                  </span>
                ) : null}
              </button>
            ))
          )}
          {filtered.length > MAX_VISIBLE ? (
            <p className="px-3 py-1.5 text-xs text-white/35">
              +{filtered.length - MAX_VISIBLE} more — keep typing to narrow
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
