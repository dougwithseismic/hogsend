"use client";

import { useHogsend } from "@hogsend/react";
import type { PlayerState, VideoEmitter, VideoEvent } from "@hogsend/video";
import { createHogsendEmitter } from "@hogsend/video/hogsend";
import { VideoPlayer } from "@hogsend/video/react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { isHogsendConfigured } from "./config";

const VIDEO_ID = "6qAB6aUMIeA";
const VIDEO_TITLE =
  "Lenny interviews Elena Verna on the new AI growth playbook";

interface FeedLine {
  key: number;
  name: string;
  detail: string;
  /** Simulated (the idle loop) vs a real event from the player. */
  sim: boolean;
}

/** The idle loop — the event contract playing itself, hero-terminal style,
 * until the visitor presses play and real events take over. */
const SIM_LOOP: Array<[string, string]> = [
  ["video.started", "0% watched"],
  ["video.progress", "milestone 25%"],
  ["video.seek", "23m → 41m"],
  ["video.progress", "milestone 50%"],
  ["video.progress", "milestone 75%"],
  ["video.progress", "milestone 90%"],
  ["video.completed", "100% watched"],
  ["video.replay", "milestones reset"],
];
const SIM_TICK_MS = 1700;
const MAX_LINES = 80;

/** Badge label from the player's live status; "standby" until playback. */
const STATUS_LABEL: Record<PlayerState["status"], string> = {
  idle: "standby",
  loading: "loading",
  playing: "playing",
  paused: "paused",
  buffering: "buffering",
  ended: "stopped",
};

/** Lovable's heart mark, inline (not in the BrandLogo registry — one-off). */
function LovableMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id="lovable-heart" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#ff8a00" />
          <stop offset="55%" stopColor="#ff4d6d" />
          <stop offset="100%" stopColor="#a34dff" />
        </linearGradient>
      </defs>
      <path
        fill="url(#lovable-heart)"
        d="M12 21s-7.5-4.7-9.9-9.2C.5 8.7 2.3 5 5.9 5c2 0 3.4 1 4.1 2.4h4C14.7 6 16.1 5 18.1 5c3.6 0 5.4 3.7 3.8 6.8C19.5 16.3 12 21 12 21z"
      />
    </svg>
  );
}

/**
 * The "Why now" video: Lenny's interview with Elena Verna (Head of Growth,
 * Lovable) played through our own @hogsend/video player. Next to it, a
 * terminal-style feed in the hero's register: it loops the watch-depth event
 * contract while idle, and the moment the visitor presses play the player's
 * REAL events take the feed over. Click-to-load — no YouTube script until
 * the visitor opts in. With the docs Hogsend client configured the real
 * events also capture to the dogfood instance.
 */
export function ManifestoVideo() {
  const [playing, setPlaying] = useState(false);
  const [status, setStatus] = useState<PlayerState["status"]>("idle");
  const [lines, setLines] = useState<FeedLine[]>([]);
  const feedRef = useRef<HTMLDivElement>(null);

  // Keep the feed pinned to the newest line unless the visitor has scrolled
  // up to read history. Re-runs on every push (the array identity changes,
  // which the `lines.length` read below makes an explicit dependency).
  useEffect(() => {
    const el = feedRef.current;
    if (!el || lines.length === 0) return;
    const nearBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < el.clientHeight / 2;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [lines]);
  const keyRef = useRef(0);
  const simIndexRef = useRef(0);
  const hasRealRef = useRef(false);

  const push = useCallback((name: string, detail: string, sim: boolean) => {
    keyRef.current += 1;
    setLines((prev) =>
      [...prev, { key: keyRef.current, name, detail, sim }].slice(-MAX_LINES),
    );
  }, []);

  // Idle loop: keep the contract cycling until a real event arrives.
  useEffect(() => {
    const tick = setInterval(() => {
      if (hasRealRef.current) return;
      const [name, detail] = SIM_LOOP[simIndexRef.current % SIM_LOOP.length];
      simIndexRef.current += 1;
      push(name, detail, true);
    }, SIM_TICK_MS);
    return () => clearInterval(tick);
  }, [push]);

  const onEvent = useCallback(
    (e: VideoEvent) => {
      if (!hasRealRef.current) {
        hasRealRef.current = true;
        setLines([]); // hand the feed over to the real stream
      }
      const pct = Math.round(Number(e.properties.percentWatched ?? 0));
      const detail =
        e.name === "video.progress"
          ? `milestone ${String(e.properties.milestone)}%`
          : e.name === "video.seek"
            ? `${Math.round(Number(e.properties.from ?? 0))}s → ${Math.round(Number(e.properties.to ?? 0))}s`
            : `${pct}% watched`;
      push(e.name, detail, false);
    },
    [push],
  );

  const onStateChange = useCallback(
    (s: Readonly<PlayerState>) => setStatus(s.status),
    [],
  );

  const statusLabel = playing ? STATUS_LABEL[status] : "standby";
  const live = playing && status === "playing";

  return (
    // items-start + a PLAIN fixed height on both boxes at the desktop
    // breakpoint (md:h-[340px]) — neither container's height may derive from
    // the other's content. (Previously the video used aspect-ratio while the
    // feed stretched to the same grid row; every new event grew the feed →
    // grew the row → grew the video → grew the row again. Fixed heights break
    // that loop entirely.) On mobile the columns stack, so the video keeps a
    // natural 16:9 and the feed its own fixed height — no side-by-side match
    // needed.
    <div className="mx-auto mt-14 grid w-full max-w-[920px] items-start gap-4 text-left md:grid-cols-[1fr_300px]">
      <div>
        <div className="relative aspect-video overflow-hidden rounded-md border border-white/[0.08] bg-black md:aspect-auto md:h-[340px]">
          {playing ? (
            isHogsendConfigured ? (
              <CapturingPlayer
                onEvent={onEvent}
                onStateChange={onStateChange}
              />
            ) : (
              <Player onEvent={onEvent} onStateChange={onStateChange} />
            )
          ) : (
            <button
              type="button"
              onClick={() => setPlaying(true)}
              aria-label={`Play video: ${VIDEO_TITLE}`}
              className="group absolute inset-0 h-full w-full"
            >
              {/* biome-ignore lint/performance/noImgElement: remote YouTube thumbnail */}
              <img
                src={`https://i.ytimg.com/vi/${VIDEO_ID}/hqdefault.jpg`}
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
            </button>
          )}
        </div>
        {/* Ad-lib attribution — sits under the video it credits. */}
        <p className="mt-3 text-[13px] text-white/45 leading-relaxed tracking-[-0.01em]">
          <span className="text-white/75">Elena Verna</span>, Head of Growth at{" "}
          <span className="inline-flex items-baseline gap-1 text-white/75">
            <LovableMark className="h-2.5 w-2.5 self-center" />
            Lovable
          </span>
          , on Lenny's Podcast. Played through our own{" "}
          <code className="text-white/60">@hogsend/video</code>; press play and
          the real watch-depth events replace the loop.{" "}
          <Link href="/components" className="font-medium text-white/75">
            All our React components →
          </Link>
        </p>
      </div>

      <div className="flex h-[260px] flex-col overflow-hidden rounded-lg border border-[#1c1d22] bg-[#101014] shadow-xl md:h-[340px]">
        {/* Card chrome — matches the feature-flags panel. */}
        <div className="shrink-0 border-white/[0.08] border-b px-4 py-3">
          <div className="flex items-center justify-between">
            <code className="font-mono text-[13px] text-white/85">
              @hogsend/video
            </code>
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-[4px] border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em]",
                live
                  ? "border-[#23c489]/30 bg-[#23c489]/10 text-[#23c489]"
                  : "border-white/10 bg-white/[0.04] text-white/45",
              )}
            >
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  live ? "ps-pulse bg-[#23c489]" : "bg-white/30",
                )}
              />
              {statusLabel}
            </span>
          </div>
          <p className="mt-1.5 text-[12px] text-white/40 leading-snug tracking-[-0.01em]">
            Watch-depth events from the player, streaming live.
          </p>
        </div>
        {/* Auto-scrolling feed: pinned to the bottom as lines arrive, but a
            real scroll container — the visitor can scroll back through the
            history. Top mask fades older lines out. */}
        <div
          ref={feedRef}
          className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-3 py-2.5 font-mono text-[11px] [mask-image:linear-gradient(to_bottom,transparent_0%,black_32%)] [scrollbar-width:none]"
        >
          <div className="mt-auto" aria-hidden="true" />
          {lines.map((l, i) => (
            <p
              key={l.key}
              className={cn(
                "mv-line-in flex items-baseline gap-2",
                i === lines.length - 1 ? "text-white/85" : "text-white/35",
              )}
            >
              <span
                className={cn(
                  "shrink-0",
                  l.sim ? "text-white/25" : "text-[#23c489]",
                )}
              >
                {l.sim ? "○" : "●"}
              </span>
              <span className="min-w-0">{l.name}</span>
              <span className="ml-auto shrink-0 text-white/30">{l.detail}</span>
            </p>
          ))}
        </div>
      </div>
      <style>{`
        @keyframes mv-line-in {
          from { opacity: 0; transform: translateY(3px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .mv-line-in { animation: mv-line-in 220ms ease-out; }
        @media (prefers-reduced-motion: reduce) {
          .mv-line-in { animation: none; }
        }
      `}</style>
    </div>
  );
}

interface PlayerProps {
  emitter?: VideoEmitter;
  onEvent: (e: VideoEvent) => void;
  onStateChange: (s: Readonly<PlayerState>) => void;
}

/** Player + capture to the docs Hogsend client (provider wraps the app root). */
function CapturingPlayer(props: Omit<PlayerProps, "emitter">) {
  const { capture } = useHogsend();
  const [emitter] = useState<VideoEmitter>(() =>
    createHogsendEmitter({ capture }),
  );
  return <Player emitter={emitter} {...props} />;
}

function Player({ emitter, onEvent, onStateChange }: PlayerProps) {
  return (
    <VideoPlayer
      src={{ youtube: VIDEO_ID }}
      title={VIDEO_TITLE}
      emitter={emitter}
      onEvent={onEvent}
      onStateChange={onStateChange}
      context={{ section: "why-now", page: "landing" }}
      autoplay
      className="absolute inset-0 h-full w-full [&>iframe]:h-full [&>iframe]:w-full"
    />
  );
}
