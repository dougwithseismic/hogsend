import { ChevronDown, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selected = options.find((o) => o.value === value);
  const all =
    !selected && value !== "" ? [{ value, label: value }, ...options] : options;
  const q = query.trim().toLowerCase();
  const filtered = q
    ? all.filter(
        (o) =>
          o.label.toLowerCase().includes(q) ||
          o.value.toLowerCase().includes(q),
      )
    : all;
  const visible = filtered.slice(0, MAX_VISIBLE);
  const trimmed = query.trim();
  const custom =
    allowCustom && trimmed !== "" && !all.some((o) => o.value === trimmed);
  const rows: Array<ComboboxOption & { isCustom?: boolean }> = custom
    ? [
        { value: trimmed, label: `Use "${trimmed}"`, isCustom: true },
        ...visible,
      ]
    : visible;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Keep the active row in view while arrowing through the list.
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function pick(next: string) {
    onChange(next);
    setOpen(false);
    setQuery("");
    inputRef.current?.blur();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open && (e.key === "ArrowDown" || e.key === "Enter")) {
      setOpen(true);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, rows.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = rows[active];
      if (hit) pick(hit.value);
    } else if (e.key === "Escape") {
      setOpen(false);
      setQuery("");
      inputRef.current?.blur();
    }
  }

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <input
        ref={inputRef}
        aria-label={ariaLabel}
        role="combobox"
        aria-expanded={open}
        placeholder={placeholder}
        value={open ? query : (selected?.label ?? value)}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          if (!open) setOpen(true);
        }}
        onFocus={() => {
          setOpen(true);
          setQuery("");
          setActive(0);
        }}
        onKeyDown={onKeyDown}
        className="flex h-9 w-full rounded-md border border-hairline-faint bg-white/[0.04] py-1 pl-3 pr-8 text-sm text-white transition-colors duration-200 placeholder:text-white/40 hover:border-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      />
      {allowClear && value !== "" ? (
        <button
          type="button"
          aria-label={`Clear ${ariaLabel}`}
          // mousedown, not click: it must win against the input's blur/close.
          onMouseDown={(e) => {
            e.preventDefault();
            pick("");
          }}
          className="absolute right-7 top-1/2 -translate-y-1/2 text-white/40 transition-colors hover:text-white"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ) : null}
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-white/40" />

      {open ? (
        <div
          ref={listRef}
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
                onMouseEnter={() => setActive(i)}
                className={cn(
                  "flex w-full items-baseline justify-between gap-3 px-3 py-1.5 text-left text-sm",
                  i === active ? "bg-white/[0.06] text-white" : "text-white/80",
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
