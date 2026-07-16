"use client";

import { useRouter, useSearchParams } from "next/navigation";
import {
  type JSX,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/cn";
import type { PlayIndexEntry } from "@/lib/playbook";
import {
  CATEGORIES,
  type CategorySlug,
  isCategorySlug,
} from "@/lib/playbook/categories";
import {
  isPersonaSlug,
  PERSONAS,
  type PersonaSlug,
} from "@/lib/playbook/personas";
import { PlayCard } from "./play-card";

const SEARCH_DEBOUNCE_MS = 250;

type Filters = {
  q: string;
  category?: CategorySlug;
  persona?: PersonaSlug;
};

function readFilters(params: URLSearchParams): Filters {
  const category = params.get("category") ?? "";
  const persona = params.get("persona") ?? "";
  return {
    q: params.get("q") ?? "",
    category: isCategorySlug(category) ? category : undefined,
    persona: isPersonaSlug(persona) ? persona : undefined,
  };
}

function buildUrl(next: Filters): string {
  const sp = new URLSearchParams();
  if (next.q) sp.set("q", next.q);
  if (next.category) sp.set("category", next.category);
  if (next.persona) sp.set("persona", next.persona);
  const qs = sp.toString();
  return qs ? `/playbook?${qs}` : "/playbook";
}

function matches(play: PlayIndexEntry, f: Filters): boolean {
  if (f.category && play.category !== f.category) return false;
  if (f.persona && !play.personas.includes(f.persona)) return false;
  if (f.q) {
    const q = f.q.toLowerCase();
    const haystack = [play.title, play.hook, ...play.tags]
      .join(" ")
      .toLowerCase();
    if (!haystack.includes(q)) return false;
  }
  return true;
}

/**
 * Client-side instant filter over the serialized play index: search input +
 * persona selector + category chip row, all URL-synced (?q=&category=&persona=)
 * so filtered views are shareable.
 */
export function PlaybookExplorer({
  plays,
}: {
  plays: PlayIndexEntry[];
}): JSX.Element {
  const router = useRouter();
  const params = useSearchParams();
  const urlFilters = readFilters(params);
  const [q, setQ] = useState(() => urlFilters.q);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const filters = useMemo<Filters>(
    () => ({ q, category: urlFilters.category, persona: urlFilters.persona }),
    [q, urlFilters.category, urlFilters.persona],
  );

  const navigateNow = useCallback(
    (next: Filters) => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      router.replace(buildUrl(next), { scroll: false });
    },
    [router],
  );

  const navigateDebounced = useCallback(
    (next: Filters) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        router.replace(buildUrl(next), { scroll: false });
      }, SEARCH_DEBOUNCE_MS);
    },
    [router],
  );

  const handleSearchChange = useCallback(
    (value: string) => {
      setQ(value);
      navigateDebounced({ ...filters, q: value });
    },
    [filters, navigateDebounced],
  );

  const handleReset = useCallback(() => {
    setQ("");
    navigateNow({ q: "" });
  }, [navigateNow]);

  const visible = useMemo(
    () => plays.filter((p) => matches(p, filters)),
    [plays, filters],
  );

  const chip = (isActive: boolean) =>
    cn(
      "shrink-0 rounded-full border px-4 py-1.5 text-sm transition-colors duration-200",
      isActive
        ? "border-accent/60 bg-accent-tint text-white"
        : "border-white/10 text-white/60 hover:border-white/25 hover:text-white",
    );

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <input
            type="search"
            value={q}
            onChange={(e) => handleSearchChange(e.target.value)}
            placeholder="Search plays — symptom, channel, event…"
            aria-label="Search plays"
            className="w-full max-w-md rounded-md border border-white/10 bg-white/[0.03] px-4 py-2.5 text-sm text-white placeholder:text-white/35 focus:border-white/25 focus:outline-none"
          />
          <label className="flex items-center gap-2 text-sm text-white/50">
            For
            <select
              value={filters.persona ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                navigateNow({
                  ...filters,
                  persona: isPersonaSlug(v) ? v : undefined,
                });
              }}
              className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-2.5 text-sm text-white focus:border-white/25 focus:outline-none"
            >
              <option value="">Everyone</option>
              {(Object.keys(PERSONAS) as PersonaSlug[]).map((p) => (
                <option key={p} value={p}>
                  {PERSONAS[p].label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <nav
          aria-label="Play categories"
          className="flex gap-2 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <button
            type="button"
            onClick={() => navigateNow({ ...filters, category: undefined })}
            aria-pressed={filters.category === undefined}
            className={chip(filters.category === undefined)}
          >
            All
          </button>
          {(Object.keys(CATEGORIES) as CategorySlug[]).map((c) => (
            <button
              key={c}
              type="button"
              onClick={() =>
                navigateNow({
                  ...filters,
                  category: filters.category === c ? undefined : c,
                })
              }
              aria-pressed={filters.category === c}
              className={chip(filters.category === c)}
            >
              {CATEGORIES[c].label}
            </button>
          ))}
        </nav>
      </div>

      {visible.length > 0 ? (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((play) => (
            <PlayCard key={play.url} play={play} />
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-start gap-3 border-white/[0.08] border-t py-10">
          <p className="text-white/55">
            No plays match that filter yet — more are on the way.
          </p>
          <button
            type="button"
            onClick={handleReset}
            className="text-sm text-white underline underline-offset-4 hover:text-white/80"
          >
            Reset filters
          </button>
        </div>
      )}
    </div>
  );
}
