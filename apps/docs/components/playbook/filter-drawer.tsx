"use client";

import { X } from "lucide-react";
import { type JSX, type ReactNode, useEffect } from "react";
import { cn } from "@/lib/cn";
import { CHANNELS, type ChannelSlug } from "@/lib/playbook/channels";
import { PERSONAS, type PersonaSlug } from "@/lib/playbook/personas";
import {
  RESULTS_BUCKETS,
  type ResultsBucketSlug,
} from "@/lib/playbook/results";

export type DrawerFilters = {
  persona?: PersonaSlug;
  channel?: ChannelSlug;
  results?: ResultsBucketSlug;
};

function FilterGroup({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <p className="eyebrow text-white/50">{label}</p>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-full border px-3.5 py-1.5 text-sm transition-colors duration-200",
        active
          ? "border-accent/60 bg-accent-tint text-white"
          : "border-white/10 text-white/60 hover:border-white/25 hover:text-white",
      )}
    >
      {children}
    </button>
  );
}

/**
 * Side drawer with the granular filter axes (who it's for, channel, time to
 * results). Category stays as the inline chip row; everything here is
 * URL-synced by the explorer via onChange.
 */
export function FilterDrawer({
  open,
  onClose,
  filters,
  onChange,
  onClearAll,
}: {
  open: boolean;
  onClose: () => void;
  filters: DrawerFilters;
  onChange: (next: DrawerFilters) => void;
  onClearAll: () => void;
}): JSX.Element {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const toggle = <K extends keyof DrawerFilters>(
    key: K,
    value: DrawerFilters[K],
  ) => {
    onChange({ ...filters, [key]: filters[key] === value ? undefined : value });
  };

  return (
    <div
      className={cn("fixed inset-0 z-50", open ? "" : "pointer-events-none")}
      aria-hidden={!open}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-close mirrors Escape */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled at the window level */}
      <div
        onClick={onClose}
        className={cn(
          "absolute inset-0 bg-black/60 transition-opacity duration-300",
          open ? "opacity-100" : "opacity-0",
        )}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Filter plays"
        className={cn(
          "absolute inset-y-0 right-0 flex w-[320px] max-w-[85vw] flex-col gap-8",
          "overflow-y-auto border-white/10 border-l bg-ink/95 p-6 pt-8",
          "backdrop-blur-md transition-transform duration-300",
          open ? "translate-x-0" : "translate-x-full",
        )}
      >
        <div className="flex items-center justify-between">
          <p className="font-display text-[18px] text-white tracking-[-0.01em]">
            Filter plays
          </p>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close filters"
            className="rounded-md p-1.5 text-white/50 transition-colors hover:text-white"
          >
            <X className="size-4" />
          </button>
        </div>

        <FilterGroup label="Who's it for">
          {(Object.keys(PERSONAS) as PersonaSlug[]).map((p) => (
            <FilterChip
              key={p}
              active={filters.persona === p}
              onClick={() => toggle("persona", p)}
            >
              {PERSONAS[p].label}
            </FilterChip>
          ))}
        </FilterGroup>

        <FilterGroup label="Channel">
          {(Object.keys(CHANNELS) as ChannelSlug[]).map((c) => (
            <FilterChip
              key={c}
              active={filters.channel === c}
              onClick={() => toggle("channel", c)}
            >
              {CHANNELS[c].label}
            </FilterChip>
          ))}
        </FilterGroup>

        <FilterGroup label="Time to results">
          {(Object.keys(RESULTS_BUCKETS) as ResultsBucketSlug[]).map((r) => (
            <FilterChip
              key={r}
              active={filters.results === r}
              onClick={() => toggle("results", r)}
            >
              {RESULTS_BUCKETS[r].label}
            </FilterChip>
          ))}
        </FilterGroup>

        <div className="mt-auto flex items-center justify-between border-white/[0.08] border-t pt-5">
          <button
            type="button"
            onClick={onClearAll}
            className="text-sm text-white/50 underline underline-offset-4 transition-colors hover:text-white"
          >
            Clear all
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-white/15 px-4 py-2 text-sm text-white transition-colors hover:border-white/30"
          >
            Done
          </button>
        </div>
      </aside>
    </div>
  );
}
