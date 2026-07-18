"use client";

import { useHogsend } from "@hogsend/react";
import type { VideoEmitter } from "@hogsend/video";
import { createHogsendEmitter } from "@hogsend/video/hogsend";
import { VideoPlayer } from "@hogsend/video/react";
import Link from "next/link";
import { type ReactNode, useState } from "react";
import { CopyButton } from "@/components/ds/copy-button";
import { isHogsendConfigured } from "@/components/hogsend/config";
import { cn } from "@/lib/cn";

/**
 * The "What's your team?" switcher — the section dogfoods Hogsend's own feature
 * flags on the marketing page.
 *
 * Left column is the RESULT: a team-matched video plus a pillar-style caption.
 * Right column is the FLAG: a `visitor-team` multivariate flag rendered as a
 * column of real toggle switches (flip one on, the rest flip off — exactly one
 * arm is ever served), the real shipping code (`defineFlag` → `useFlag` →
 * `flags.evaluate`), and a live evaluation readout. It's simulated client-side
 * (a visitor self-selects), but the code is the genuine API. Every video runs
 * through our own @hogsend/video player.
 *
 * `CodeHighlight` is an async RSC, so the three highlighted snippets are
 * rendered in the page and handed in as `code` nodes.
 */

type TeamKey = "founder" | "growth" | "product" | "sales" | "hr";

const TEAM_ORDER: readonly TeamKey[] = [
  "founder",
  "growth",
  "product",
  "sales",
  "hr",
];

interface Team {
  /** Toggle label. */
  label: string;
  /** The value the multivariate flag serves for this arm. */
  value: string;
  /** Pillar-style caption under the video: a tight title + a factual body. */
  title: string;
  body: string;
  video: { id: string; title: string };
}

// Per-team videos are plain config — swap an id and the arm changes. All ids
// are verified to resolve a YouTube thumbnail.
const TEAMS: Record<TeamKey, Team> = {
  founder: {
    label: "Founder",
    value: "founder",
    title: "Lifecycle without the hire",
    body: "Onboarding, trials, and win-back ship as code your agents extend, with no lifecycle team to staff.",
    video: {
      id: "f4_14pZlJBs",
      title: "Before the Startup, with Paul Graham",
    },
  },
  growth: {
    label: "Growth",
    value: "growth",
    title: "Every loop in the repo",
    body: "Trigger on real events and read the same flag in the browser, on the server, and inside a journey.",
    video: {
      id: "6qAB6aUMIeA",
      title: "Lenny interviews Elena Verna on the new AI growth playbook",
    },
  },
  product: {
    label: "Product",
    value: "product",
    title: "Journeys ship with features",
    body: "Wire activation and onboarding into the product you're already building, not a separate tool.",
    video: {
      id: "h-KVGHoQ_98",
      title: "The Nature of Product, with Marty Cagan (Lenny's Podcast)",
    },
  },
  sales: {
    label: "Sales",
    value: "sales",
    title: "Follow-ups on the signal",
    body: "Fire the next touch the moment the event lands. No batch, no waiting on marketing to build the flow.",
    video: {
      id: "-Awbn72F4hY",
      title: "22 Minutes of the Best Alex Hormozi Sales Tips",
    },
  },
  hr: {
    label: "HR",
    value: "hr",
    title: "Onboarding that runs itself",
    body: "Candidate nurture and new-hire sequences as journeys, on the same triggers and code as everything else.",
    video: {
      id: "i_PjjXKNpA4",
      title: "The Startup Playbook for Hiring Your First Engineers",
    },
  },
};

type CodeTab = "define" | "react" | "server";
const CODE_TABS: Array<{ key: CodeTab; filename: string; lang: string }> = [
  { key: "define", filename: "src/flags/index.ts", lang: "ts" },
  { key: "react", filename: "src/app/hero.tsx", lang: "tsx" },
  { key: "server", filename: "src/server/team.ts", lang: "ts" },
];

type FlagPersonaSwitcherProps = {
  /** Pre-highlighted (Shiki, RSC) snippets, one per code tab. */
  code: Record<CodeTab, ReactNode>;
  /** Raw sources, for the per-tab copy button. */
  raw: Record<CodeTab, string>;
};

export function FlagPersonaSwitcher({ code, raw }: FlagPersonaSwitcherProps) {
  const [team, setTeam] = useState<TeamKey>("founder");
  const [tab, setTab] = useState<CodeTab>("react");
  const [playing, setPlaying] = useState(false);

  const active = TEAMS[team];

  function choose(next: TeamKey) {
    if (next === team) return; // one arm always stays on
    setTeam(next);
    setPlaying(false); // new arm → new video, back to its poster
  }

  return (
    <div className="grid items-start gap-5 lg:grid-cols-[1fr_380px]">
      {/* LEFT — the result: video + a pillar-style caption for this arm. */}
      <div>
        <div className="relative aspect-video overflow-hidden rounded-md border border-white/[0.08] bg-black">
          {playing ? (
            isHogsendConfigured ? (
              <CapturingTeamPlayer
                videoId={active.video.id}
                title={active.video.title}
                team={active.value}
              />
            ) : (
              <TeamPlayer
                videoId={active.video.id}
                title={active.video.title}
                team={active.value}
              />
            )
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

        {/* Pillar-style caption — matches the "Journeys as code" feature row. */}
        <div aria-live="polite" className="mt-5">
          <h3 className="font-medium text-base text-white tracking-[-0.025em]">
            {active.title}
          </h3>
          <p className="mt-2 max-w-[460px] text-sm text-white/55 leading-[21px] tracking-[-0.02em]">
            {active.body}
          </p>
        </div>
      </div>

      {/* RIGHT — the flag: toggle arms + the real code + live readout. */}
      <div className="overflow-hidden rounded-lg border border-[#1c1d22] bg-[#101014] shadow-xl">
        {/* Flag header — reads like a Studio flag card. */}
        <div className="border-white/[0.08] border-b px-4 py-3">
          <div className="flex items-center justify-between">
            <code className="font-mono text-[13px] text-white/85">
              visitor-team
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
          {TEAM_ORDER.map((key) => {
            const isActive = key === team;
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
                  {TEAMS[key].label}
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
        <div className="max-h-[240px] overflow-auto px-4 py-3.5 text-[12.5px]">
          {code[tab]}
        </div>

        {/* Live evaluation — the flag this page is reading, right now. Label on
            its own line so the key → value pair never wraps into columns. */}
        <div className="border-white/[0.08] border-t bg-white/[0.03] px-4 py-3">
          <p className="mb-1.5 font-mono text-[10px] text-white/40 uppercase tracking-[0.08em]">
            evaluated for you
          </p>
          <div className="flex items-center gap-2 font-mono text-[12.5px]">
            <span className="text-white/55">visitor-team</span>
            <span className="text-white/30">→</span>
            <span className="text-[#f8a08f]">"{active.value}"</span>
          </div>
        </div>
      </div>

      {/* Footer row — honest note + deep link, spanning both columns. */}
      <div className="flex flex-wrap items-center justify-between gap-3 lg:col-span-2">
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

interface TeamPlayerProps {
  videoId: string;
  title: string;
  team: string;
  emitter?: VideoEmitter;
}

/** Every team video runs through our own @hogsend/video player. */
function TeamPlayer({ videoId, title, team, emitter }: TeamPlayerProps) {
  return (
    <VideoPlayer
      key={videoId}
      src={{ youtube: videoId }}
      title={title}
      emitter={emitter}
      context={{ section: "feature-flags", team }}
      autoplay
      className="absolute inset-0 h-full w-full [&>iframe]:h-full [&>iframe]:w-full"
    />
  );
}

/** Dogfood capture: real watch-depth events flow to the docs Hogsend client
 * (the provider wraps the app root), same as the "why now" player. */
function CapturingTeamPlayer(props: Omit<TeamPlayerProps, "emitter">) {
  const { capture } = useHogsend();
  const [emitter] = useState<VideoEmitter>(() =>
    createHogsendEmitter({ capture }),
  );
  return <TeamPlayer emitter={emitter} {...props} />;
}
