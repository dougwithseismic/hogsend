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
 * The persona chips are a MULTIVARIATE flag (`visitor-persona`): pick one arm
 * and the rest flip off — the video, the headline, and the pitch all follow.
 * It's simulated client-side here (a visitor self-selects), but the code panel
 * on the right is the REAL shipping API: `defineFlag()` → `useFlag()` →
 * `hogsend.flags.evaluate()`. One definition, every surface.
 *
 * `CodeHighlight` is an async RSC, so the three highlighted snippets are
 * rendered in the page and handed in as `code` nodes.
 */

type PersonaKey =
  | "founder"
  | "growth_engineer"
  | "sales"
  | "recruiter"
  | "browsing"
  | "curious";

const PERSONA_ORDER: readonly PersonaKey[] = [
  "founder",
  "growth_engineer",
  "sales",
  "recruiter",
  "browsing",
  "curious",
];

interface Persona {
  /** Chip label. */
  chip: string;
  /** The value the multivariate flag serves for this arm. */
  value: string;
  headline: string;
  sub: string;
  video: { id: string; title: string };
}

// Per-persona videos are plain config — swap an id and the arm changes. All six
// ids are verified to resolve a YouTube thumbnail.
const PERSONAS: Record<PersonaKey, Persona> = {
  founder: {
    chip: "Founder",
    value: "founder",
    headline: "Being a founder is hard enough.",
    sub: "Your lifecycle shouldn't need a full-time operator. Ship onboarding, trials, and win-back as code — and let your agents extend it.",
    video: {
      id: "f4_14pZlJBs",
      title: "Before the Startup — Paul Graham (How to Start a Startup)",
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
    sub: "Fire the follow-up the moment the signal lands — no batch, no waiting on marketing to build the flow.",
    video: {
      id: "-Awbn72F4hY",
      title: "22 Minutes of the Best Alex Hormozi Sales Tips",
    },
  },
  recruiter: {
    chip: "Recruiter",
    value: "recruiter",
    headline: "Hiring growth engineers?",
    sub: "This is the stack they want to work in — code-first lifecycle, agent-native, versioned in git. No drag-and-drop canvas.",
    video: {
      id: "i_PjjXKNpA4",
      title: "The Startup Playbook for Hiring Your First Engineers",
    },
  },
  browsing: {
    chip: "Just browsing",
    value: "browsing",
    headline: "Take your time.",
    sub: "Every chip above is one feature flag deciding what you see. That's the whole product — running on itself, right on this page.",
    video: {
      id: "6qAB6aUMIeA",
      title: "Lenny interviews Elena Verna — the new AI growth playbook",
    },
  },
  curious: {
    chip: "Curious",
    value: "curious",
    headline: "Wondering how this works?",
    sub: "One multivariate flag picks your arm. Define it once, read it in the browser, on the server, and inside a journey.",
    video: {
      id: "GXVB8yVIm7I",
      title: "What Is Growth Engineering? Here's How It Really Works",
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
    setPersona(next);
    setPlaying(false); // new arm → new video, back to its poster
  }

  const activeTab = CODE_TABS.find((t) => t.key === tab) ?? CODE_TABS[0];

  return (
    <div>
      {/* Persona chips — the multivariate flag's arms. Single-select: pick one,
          the rest flip off. */}
      <div
        role="tablist"
        aria-label="Who are you?"
        className="flex flex-wrap gap-2"
      >
        {PERSONA_ORDER.map((key) => {
          const isActive = key === persona;
          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => choose(key)}
              className={cn(
                "select-none rounded-[6px] border px-4 py-2 font-medium text-sm tracking-[-0.025em] outline-none transition-colors duration-200",
                isActive
                  ? "border-white bg-white text-[#0a0a0a]"
                  : "border-white/10 bg-white/[0.04] text-white/75 hover:border-white/30",
              )}
            >
              {PERSONAS[key].chip}
            </button>
          );
        })}
      </div>

      <div className="mt-8 grid items-start gap-4 lg:grid-cols-[1fr_380px]">
        {/* Left: the persona pitch + its video. Both react to the flag. */}
        <div>
          <div
            aria-live="polite"
            className="min-h-[104px] rounded-lg border border-white/[0.08] bg-white/[0.02] px-6 py-5"
          >
            <p
              className={cn(
                "font-normal text-[26px] text-white leading-[1.15] tracking-[-0.01em] md:text-[30px]",
                "[font-family:var(--ps-display)]",
              )}
            >
              {active.headline}
            </p>
            <p className="mt-2 max-w-[560px] text-[15px] text-white/60 leading-relaxed tracking-[-0.01em]">
              {active.sub}
            </p>
          </div>

          <div className="relative mt-4 aspect-video overflow-hidden rounded-md border border-white/[0.08] bg-black">
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
        </div>

        {/* Right: the real flag API, plus a live evaluation readout that ties
            the code to the chips above. */}
        <div className="overflow-hidden rounded-lg border border-[#1c1d22] bg-[#101014] shadow-xl">
          {/* Tab bar */}
          <div
            role="tablist"
            aria-label="Where the flag is read"
            className="flex items-center gap-1 border-white/[0.08] border-b px-2"
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
                    "border-b-2 px-3 py-2.5 font-mono text-[11px] tracking-wide outline-none transition-colors",
                    isActive
                      ? "border-[#f64838] text-white/80"
                      : "border-transparent text-white/40 hover:text-white/70",
                  )}
                >
                  {t.filename}
                </button>
              );
            })}
            <span className="ml-auto flex items-center gap-2 pr-2">
              <span className="rounded-[4px] bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-white/40 uppercase tracking-[0.08em]">
                {activeTab.lang}
              </span>
              <CopyButton value={raw[tab]} />
            </span>
          </div>

          <div className="ps-code max-h-[300px] overflow-auto px-4 py-4 text-[12.5px]">
            {code[tab]}
          </div>

          {/* Live evaluation — the flag this page is reading, right now. */}
          <div className="border-white/[0.08] border-t bg-white/[0.03] px-4 py-3">
            <p className="mb-2 font-mono text-[10px] text-white/35 uppercase tracking-[0.08em]">
              evaluated for you
            </p>
            <div className="flex items-center justify-between font-mono text-[12px]">
              <span className="text-white/50">visitor-persona</span>
              <span className="flex items-center gap-2">
                <span className="text-white/30">→</span>
                <span className="text-[#f8a08f]">"{active.value}"</span>
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Footer row — honest note + deep link. */}
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-[640px] text-white/55 text-sm tracking-[-0.02em]">
          One definition, read everywhere — same evaluation in the browser, on
          the server, and in a journey. Already run PostHog flags? Keep them;
          read them right beside these.
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
