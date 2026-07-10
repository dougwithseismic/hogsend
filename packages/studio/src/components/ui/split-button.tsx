import { Check, ChevronDown } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";

export type SplitItem<T extends string> = {
  id: T;
  label: string;
  Icon?: (props: { className?: string }) => ReactNode;
  /** Brand tint for the mark, if any. */
  color?: string;
};

/**
 * The crimzon split button: a primary that fires the last-picked option
 * (persisted per browser under `storageKey`) and a caret that reveals the rest.
 * Outside-click / Escape close the menu. Shared by the journey "Ask AI" and
 * "Export" toolbar actions and the Links QR export so they stay
 * pixel-identical.
 */
export function SplitButton<T extends string>({
  items,
  storageKey,
  defaultId,
  onAct,
  renderLabel,
  caretLabel,
  primaryIcon,
}: {
  items: readonly SplitItem<T>[];
  storageKey: string;
  defaultId: T;
  onAct: (id: T) => void;
  renderLabel: (item: SplitItem<T>) => string;
  caretLabel: string;
  primaryIcon?: {
    Icon: (props: { className?: string }) => ReactNode;
    color?: string;
  };
}) {
  const isKnown = useCallback(
    (v: string | null): v is T => !!v && items.some((i) => i.id === v),
    [items],
  );
  const [selected, setSelected] = useState<T>(() => {
    try {
      const v = localStorage.getItem(storageKey);
      if (isKnown(v)) return v;
    } catch {
      // localStorage can throw (privacy mode) — fall back to the default.
    }
    return defaultId;
  });
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      // `Node` can be shadowed by callers' types — reach for the DOM one.
      const target = e.target;
      if (
        rootRef.current &&
        target instanceof globalThis.Node &&
        !rootRef.current.contains(target)
      ) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = items.find((i) => i.id === selected) ?? items[0];
  if (!current) return null;

  const choose = (id: T) => {
    setSelected(id);
    try {
      localStorage.setItem(storageKey, id);
    } catch {
      // best-effort persistence
    }
    setOpen(false);
    onAct(id);
  };

  const primary =
    primaryIcon ??
    (current.Icon ? { Icon: current.Icon, color: current.color } : undefined);
  const PrimaryIcon = primary?.Icon;

  return (
    <div ref={rootRef} className="relative inline-flex">
      <Button
        variant="outline"
        size="sm"
        className="rounded-r-none pr-2.5"
        onClick={() => onAct(current.id)}
      >
        {PrimaryIcon ? (
          <span
            className="inline-flex"
            style={primary?.color ? { color: primary.color } : undefined}
          >
            <PrimaryIcon className="h-3.5 w-3.5" />
          </span>
        ) : null}
        {renderLabel(current)}
      </Button>
      <Button
        variant="outline"
        size="sm"
        aria-label={caretLabel}
        aria-expanded={open}
        className="rounded-l-none border-l-0 px-1.5"
        onClick={() => setOpen((o) => !o)}
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </Button>
      {open ? (
        <div className="absolute right-0 top-full z-20 mt-1 min-w-[10rem] overflow-hidden rounded-md border border-hairline-faint bg-raised shadow-lg">
          {items.map((item) => {
            const Icon = item.Icon;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => choose(item.id)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-white/80 transition-colors hover:bg-white/5"
              >
                {Icon ? (
                  <span
                    className="inline-flex"
                    style={item.color ? { color: item.color } : undefined}
                  >
                    <Icon className="h-3.5 w-3.5" />
                  </span>
                ) : null}
                {renderLabel(item)}
                {item.id === selected ? (
                  <Check className="ml-auto h-3 w-3 text-accent" />
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
