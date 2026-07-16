"use client";

import { SlidersHorizontal } from "lucide-react";
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
  CHANNELS,
  type ChannelSlug,
  isChannelSlug,
} from "@/lib/playbook/channels";
import {
  isPersonaSlug,
  PERSONAS,
  type PersonaSlug,
} from "@/lib/playbook/personas";
import {
  isResultsBucketSlug,
  type ResultsBucketSlug,
  resultsBucket,
} from "@/lib/playbook/results";
import { FilterDrawer } from "./filter-drawer";
import { PlayCard } from "./play-card";

const SEARCH_DEBOUNCE_MS = 250;

type Filters = {
  q: string;
  category?: CategorySlug;
  persona?: PersonaSlug;
  channel?: ChannelSlug;
  results?: ResultsBucketSlug;
};

function readFilters(params: URLSearchParams): Filters {
  const category = params.get("category") ?? "";
  const persona = params.get("persona") ?? "";
  const channel = params.get("channel") ?? "";
  const results = params.get("results") ?? "";
  return {
    q: params.get("q") ?? "",
    category: isCategorySlug(category) ? category : undefined,
    persona: isPersonaSlug(persona) ? persona : undefined,
    channel: isChannelSlug(channel) ? channel : undefined,
    results: isResultsBucketSlug(results) ? results : undefined,
  };
}

function buildUrl(next: Filters): string {
  const sp = new URLSearchParams();
  if (next.q) sp.set("q", next.q);
  if (next.category) sp.set("category", next.category);
  if (next.persona) sp.set("persona", next.persona);
  if (next.channel) sp.set("channel", next.channel);
  if (next.results) sp.set("results", next.results);
  const qs = sp.toString();
  return qs ? `/playbook?${qs}` : "/playbook";
}

function matches(play: PlayIndexEntry, f: Filters): boolean {
  if (f.category && play.category !== f.category) return false;
  if (f.persona && !play.personas.includes(f.persona)) return false;
  if (f.channel && !play.channels.includes(f.channel)) return false;
  if (f.results && resultsBucket(play.timeToResults) !== f.results)
    return false;
  if (f.q) {
    const q = f.q.toLowerCase();
    const haystack = [
      play.title,
      play.hook,
      ...play.tags,
      CATEGORIES[play.category].label,
      ...play.personas.map((p) => PERSONAS[p].label),
      ...play.channels.map((c) => CHANNELS[c].label),
    ]
      .join(" ")
      .toLowerCase();
    if (!haystack.includes(q)) return false;
  }
  return true;
}

/**
 * Client-side instant filter over the serialized play index: search input +
 * category chip row inline, with the granular axes (persona, channel, time
 * to results) in a side drawer. All URL-synced so filtered views are
 * shareable.
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
  const [drawerOpen, setDrawerOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  // Re-sync local q with the URL when it changes externally (back/forward
  // navigation, or a client-side nav to /playbook?q=... while mounted).
  // Skipped while a debounce is pending so it doesn't clobber in-flight typing.
  useEffect(() => {
    if (debounceRef.current) return;
    setQ(urlFilters.q);
  }, [urlFilters.q]);

  const filters = useMemo<Filters>(
    () => ({
      q,
      category: urlFilters.category,
      persona: urlFilters.persona,
      channel: urlFilters.channel,
      results: urlFilters.results,
    }),
    [
      q,
      urlFilters.category,
      urlFilters.persona,
      urlFilters.channel,
      urlFilters.results,
    ],
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
        debounceRef.current = null;
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

  const drawerCount = [
    filters.persona,
    filters.channel,
    filters.results,
  ].filter(Boolean).length;

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
        <div className="flex items-center gap-3">
          <input
            type="search"
            value={q}
            onChange={(e) => handleSearchChange(e.target.value)}
            placeholder="Search plays — symptom, channel, event…"
            aria-label="Search plays"
            className="w-full max-w-md rounded-md border border-white/10 bg-white/[0.03] px-4 py-2.5 text-sm text-white placeholder:text-white/35 focus:border-white/25 focus:outline-none"
          />
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            className={cn(
              "inline-flex shrink-0 items-center gap-2 rounded-md border px-4 py-2.5 text-sm transition-colors duration-200",
              drawerCount > 0
                ? "border-accent/60 bg-accent-tint text-white"
                : "border-white/10 text-white/60 hover:border-white/25 hover:text-white",
            )}
          >
            <SlidersHorizontal className="size-3.5" />
            Filters
            {drawerCount > 0 ? (
              <span className="rounded-full bg-white/15 px-1.5 font-mono text-[11px] text-white">
                {drawerCount}
              </span>
            ) : null}
          </button>
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

      <FilterDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        filters={{
          persona: filters.persona,
          channel: filters.channel,
          results: filters.results,
        }}
        onChange={(next) => navigateNow({ ...filters, ...next })}
        onClearAll={() =>
          navigateNow({
            ...filters,
            persona: undefined,
            channel: undefined,
            results: undefined,
          })
        }
      />
    </div>
  );
}
