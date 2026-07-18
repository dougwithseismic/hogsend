"use client";

import { VideoPlayer } from "@hogsend/video/react";
import Link from "next/link";
import { type ReactNode, useState } from "react";
import { CopyButton } from "@/components/ds/copy-button";
import { cn } from "@/lib/cn";

/**
 * The "Who's reading this?" switcher — the section dogfoods Hogsend's own
 * feature flags on the marketing page.
 *
 * Left column is the RESULT: a persona-matched video plus its headline/pitch.
 * Right column is the FLAG: a `visitor-persona` multivariate flag rendered as a
 * row of real toggle switches (flip one on, the rest flip off — exactly one arm
 * is ever served), the real shipping code (`defineFlag` → `useFlag` →
 * `flags.evaluate`), and a live evaluation readout. It's simulated client-side
 * (a visitor self-selects), but the code is the genuine API.
 *
 * `CodeHighlight` is an async RSC, so the three highlighted snippets are
 * rendered in the page and handed in as `code` nodes.
 */

type PersonaKey =
  | "founder"
  | "growth_engineer"
  | "sales"
  | "recruiter"
  | "browsing";

const PERSONA_ORDER: readonly PersonaKey[] = [
  "founder",
  "growth_engineer",
  "sales",
  "recruiter",
  "browsing",
];

interface Persona {
  /** Toggle label. */
  chip: string;
  /** The value the multivariate flag serves for this arm. */
  value: string;
  headline: string;
  sub: string;
  video: { id: string; title: string };
}

// Per-persona videos are plain config — swap an id and the arm changes. All
// ids are verified to resolve a YouTube thumbnail.
const PERSONAS: Record<PersonaKey, Persona> = {
  founder: {
    chip: "Founder",
    value: "founder",
    headline: "Being a founder is hard enough.",
    sub: "Your lifecycle shouldn't need a full-time operator. Ship onboarding, trials, and win-back as code your agents can extend.",
    video: {
      id: "f4_14pZlJBs",
      title: "Before the Startup, with Paul Graham",
    },
  },
  growth_engineer: {
    chip: "Growth engineer",
    value: "growth_engineer",
    headline: "Your journeys belong in the repo.",
    sub: "TypeScript, versioned, reviewed in a PR. Read the same flag in the browser, on the server, and inside a journey.",
    video: {
      id: "tBh5MHb5KJM",
      title: "Growth Engineering with Alexey Komissarouk",
    },
  },
  sales: {
    chip: "Sales",
    value: "sales",
    headline: "More offers out. More replies back.",
    sub: "Fire the follow-up the moment the signal lands. No batch, no waiting on marketing to build the flow.",
    video: {
      id: "-Awbn72F4hY",
      title: "22 Minutes of the Best Alex Hormozi Sales Tips",
    },
  },
  recruiter: {
    chip: "Recruiter",
    value: "recruiter",
    headline: "Hiring growth engineers?",
    sub: "This is the stack they want to work in: code-first lifecycle, agent-native, versioned in git. No drag-and-drop canvas.",
    video: {
      id: "i_PjjXKNpA4",
      title: "The Startup Playbook for Hiring Your First Engineers",
    },
  },
  browsing: {
    chip: "Just browsing",
    value: "browsing",
    headline: "Take a look around.",
    sub: "Every toggle here is one arm of the same flag. It's the whole product running on itself, right on this page.",
    video: {
      id: "6qAB6aUMIeA",
      title: "Lenny interviews Elena Verna on the new AI growth playbook",
    },
  },
};

type CodeTab = "define" | "react" | "server";
const CODE_TABS: Array<{ key: CodeTab; filename: string; lang: string }> = [
  { key: "define", filename: "src/flags/index.ts", lang: "ts" },
  { key: "react", filename: "src/app/hero.tsx", lang: "tsx" },
  { key: "server", filename: "src/server/persona.ts", lang: "ts" },
];

type FlagPersonaSwitcherProps = {
  /** Pre-highlighted (Shiki, RSC) snippets, one per code tab. */
  code: Record<CodeTab, ReactNode>;
  /** Raw sources, for the per-tab copy button. */
  raw: Record<CodeTab, string>;
};

export function FlagPersonaSwitcher({ code, raw }: FlagPersonaSwitcherProps) {
  const [persona, setPersona] = useState<PersonaKey>("founder");
  const [tab, setTab] = useState<CodeTab>("react");
  const [playing, setPlaying] = useState(false);

  const active = PERSONAS[persona];

  function choose(next: PersonaKey) {
    if (next === persona) return; // one arm always stays on
    setPersona(next);
    setPlaying(false); // new arm → new video, back to its poster
  }

  return (
    <div className="grid items-start gap-5 lg:grid-cols-[1fr_400px]">
      {/* LEFT — the result: video + the pitch this arm renders. */}
      <div>
        <div className="relative aspect-video overflow-hidden rounded-md border border-white/[0.08] bg-black">
          {playing ? (
            <VideoPlayer
              key={active.video.id}
              src={{ youtube: active.video.id }}
              title={active.video.title}
              context={{ section: "feature-flags", persona: active.value }}
              autoplay
              className="absolute inset-0 h-full w-full [&>iframe]:h-full [&>iframe]:w-full"
            />
          ) : (
            <button
              type="button"
              onClick={() => setPlaying(true)}
              aria-label={`Play video: ${active.video.title}`}
              className="group absolute inset-0 h-full w-full"
            >
              {/* biome-ignore lint/performance/noImgElement: remote YouTube thumbnail */}
              <img
                key={active.video.id}
                src={`https://i.ytimg.com/vi/${active.video.id}/hqdefault.jpg`}
                alt=""
                loading="lazy"
                className="absolute inset-0 h-full w-full object-cover opacity-80 transition-opacity group-hover:opacity-100"
              />
              <span className="absolute inset-0 flex items-center justify-center">
                <span className="flex h-14 w-20 items-center justify-center rounded-xl bg-black/70 transition-colors group-hover:bg-[#f64838]">
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 24 24"
                    className="h-7 w-7 fill-white"
                  >
                    <path d="M8 5.5v13l11-6.5-11-6.5z" />
                  </svg>
                </span>
              </span>
              <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/80 to-transparent px-4 pt-8 pb-3 text-left font-mono text-[11px] text-white/70">
                {active.video.title}
              </span>
            </button>
          )}
        </div>

        <div
          aria-live="polite"
          className="mt-4 rounded-lg border border-white/[0.08] bg-white/[0.02] px-6 py-5"
        >
          <p
            className={cn(
              "font-normal text-[26px] text-white leading-[1.15] tracking-[-0.01em] md:text-[30px]",
              "[font-family:var(--ps-display)]",
            )}
          >
            {active.headline}
          </p>
          <p className="mt-2 text-[15px] text-white/60 leading-relaxed tracking-[-0.01em]">
            {active.sub}
          </p>
        </div>
      </div>

      {/* RIGHT — the flag: toggle arms + the real code + live readout. */}
      <div className="overflow-hidden rounded-lg border border-[#1c1d22] bg-[#101014] shadow-xl">
        {/* Flag header — reads like a Studio flag card. */}
        <div className="border-white/[0.08] border-b px-4 py-3">
          <div className="flex items-center justify-between">
            <code className="font-mono text-[13px] text-white/85">
              visitor-persona
            </code>
            <span className="rounded-[4px] border border-white/10 bg-white/[0.04] px-1.5 py-0.5 font-mono text-[10px] text-white/45 uppercase tracking-[0.08em]">
              multivariate
            </span>
          </div>
          <p className="mt-1.5 text-[12px] text-white/40 leading-snug tracking-[-0.01em]">
            One arm per visitor. Your targeting rules choose it in production;
            flip the arms here to preview.
          </p>
        </div>

        {/* Toggle arms — flip one on, the rest flip off. */}
        <fieldset className="flex flex-col gap-0.5 px-2 py-2">
          {PERSONA_ORDER.map((key) => {
            const isActive = key === persona;
            return (
              <button
                key={key}
                type="button"
                role="switch"
                aria-checked={isActive}
                onClick={() => choose(key)}
                className={cn(
                  "flex items-center justify-between rounded-[6px] px-2.5 py-2 text-left outline-none transition-colors",
                  isActive ? "bg-white/[0.05]" : "hover:bg-white/[0.03]",
                )}
              >
                <span
                  className={cn(
                    "font-medium text-[13px] tracking-[-0.02em] transition-colors",
                    isActive ? "text-white" : "text-white/55",
                  )}
                >
                  {PERSONAS[key].chip}
                </span>
                <span
                  aria-hidden="true"
                  className={cn(
                    "relative h-[18px] w-8 shrink-0 rounded-full transition-colors",
                    isActive ? "bg-[#f64838]" : "bg-white/15",
                  )}
                >
                  <span
                    className={cn(
                      "absolute top-0.5 size-3.5 rounded-full bg-white transition-transform",
                      isActive ? "translate-x-[15px]" : "translate-x-0.5",
                    )}
                  />
                </span>
              </button>
            );
          })}
        </fieldset>

        {/* Code — the real API. The file-name tabs scroll horizontally so
            long paths stay reachable; the copy button stays pinned. */}
        <div className="flex items-center border-white/[0.08] border-t border-b">
          <div
            role="tablist"
            aria-label="Where the flag is read"
            className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {CODE_TABS.map((t) => {
              const isActive = t.key === tab;
              return (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => setTab(t.key)}
                  className={cn(
                    "shrink-0 whitespace-nowrap border-b-2 px-2.5 py-2.5 font-mono text-[11px] tracking-wide outline-none transition-colors",
                    isActive
                      ? "border-[#f64838] text-white/80"
                      : "border-transparent text-white/40 hover:text-white/70",
                  )}
                >
                  {t.filename}
                </button>
              );
            })}
          </div>
          <span className="shrink-0 border-white/[0.06] border-l px-2">
            <CopyButton value={raw[tab]} />
          </span>
        </div>

        {/* No line numbers — Shiki's transparent <pre>, our mono type. */}
        <div className="max-h-[260px] overflow-auto px-4 py-3.5 text-[12.5px]">
          {code[tab]}
        </div>

        {/* Live evaluation — the flag this page is reading, right now. */}
        <div className="flex items-center justify-between border-white/[0.08] border-t bg-white/[0.03] px-4 py-3 font-mono text-[12px]">
          <span className="text-white/45 uppercase tracking-[0.08em] text-[10px]">
            evaluated for you
          </span>
          <span className="flex items-center gap-2">
            <span className="text-white/50">visitor-persona</span>
            <span className="text-white/30">→</span>
            <span className="text-[#f8a08f]">"{active.value}"</span>
          </span>
        </div>
      </div>

      {/* Footer row — honest note + deep link, spanning both columns. */}
      <div className="lg:col-span-2 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-[640px] text-white/55 text-sm tracking-[-0.02em]">
          One definition, read everywhere. The same evaluation runs in the
          browser, on the server, and inside a journey. Already run PostHog
          flags? Keep them and read them right beside these.
        </p>
        <Link
          href="/docs/flags"
          className="font-medium text-white text-sm tracking-[-0.025em] hover:opacity-70"
        >
          Read the flags docs →
        </Link>
      </div>
    </div>
  );
}
