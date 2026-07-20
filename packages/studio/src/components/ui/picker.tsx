import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/**
 * Shared controller for the searchable pickers (Combobox, EventPicker,
 * ContactPicker): one implementation of the popover state (open/query/active),
 * the outside-click close, the active-row scroll-into-view, and the keyboard
 * protocol (arrows move, Enter picks, Escape closes). Components keep their
 * own row model and rendering — this owns only the interaction mechanics, so
 * the next picker (groups, campaigns, …) starts from behavior that already
 * works everywhere.
 */
export function usePicker() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

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

  function close() {
    setOpen(false);
    setQuery("");
    inputRef.current?.blur();
  }

  /** Build the input's onKeyDown for the current row count + pick action. */
  const keyDown =
    (rowCount: number, pickAt: (index: number) => void) =>
    (e: React.KeyboardEvent) => {
      if (!open && (e.key === "ArrowDown" || e.key === "Enter")) {
        setOpen(true);
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((a) => Math.min(a + 1, rowCount - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => Math.max(a - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (rowCount > 0) pickAt(Math.min(active, rowCount - 1));
      } else if (e.key === "Escape") {
        close();
      }
    };

  /** Spread onto the input: query editing + open-on-focus. */
  const inputProps = {
    role: "combobox" as const,
    "aria-expanded": open,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
      setQuery(e.target.value);
      setActive(0);
      if (!open) setOpen(true);
    },
    onFocus: () => {
      setOpen(true);
      setQuery("");
      setActive(0);
    },
  };

  return {
    open,
    query,
    active,
    setActive,
    rootRef,
    inputRef,
    listRef,
    close,
    keyDown,
    inputProps,
  };
}

/** The shared input styling (Input's look with room for the chevron). */
export const PICKER_INPUT_CLASS =
  "flex h-9 w-full rounded-md border border-hairline-faint bg-white/[0.04] py-1 pl-3 pr-8 text-sm text-white transition-colors duration-200 placeholder:text-white/40 hover:border-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

/** The × that resets a picker to its "All" state. */
export function PickerClearButton({
  label,
  onClear,
}: {
  label: string;
  onClear: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      // mousedown, not click: it must win against the input's blur/close.
      onMouseDown={(e) => {
        e.preventDefault();
        onClear();
      }}
      className="absolute right-7 top-1/2 -translate-y-1/2 text-white/40 transition-colors hover:text-white"
    >
      <X className="h-3.5 w-3.5" />
    </button>
  );
}
