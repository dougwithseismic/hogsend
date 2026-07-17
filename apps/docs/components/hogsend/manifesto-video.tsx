"use client";

import { useHogsend } from "@hogsend/react";
import type { VideoEmitter, VideoEvent } from "@hogsend/video";
import { createHogsendEmitter } from "@hogsend/video/hogsend";
import { VideoPlayer } from "@hogsend/video/react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { isHogsendConfigured } from "./config";

const VIDEO_ID = "6qAB6aUMIeA";
const VIDEO_TITLE = "Lenny interviews Elena Verna — the new AI growth playbook";

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
const MAX_LINES = 7;

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
  const [lines, setLines] = useState<FeedLine[]>([]);
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

  return (
    <div className="mx-auto mt-14 grid w-full max-w-[920px] gap-4 text-left md:grid-cols-[1fr_300px]">
      <div className="relative aspect-video overflow-hidden rounded-md border border-white/[0.08] bg-black">
        {playing ? (
          isHogsendConfigured ? (
            <CapturingPlayer onEvent={onEvent} />
          ) : (
            <Player onEvent={onEvent} />
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

      <div className="flex flex-col overflow-hidden rounded-md border border-white/[0.08] bg-[#0a0606]">
        {/* Terminal chrome, matching the hero window. */}
        <div className="flex items-center justify-between border-white/10 border-b px-3 py-2">
          <span className="font-mono text-[11px] text-white/40 tracking-wide">
            @hogsend/video — event feed
          </span>
          <span className="flex items-center gap-1.5 font-mono text-[#23c489] text-[11px]">
            <span className="ps-pulse size-1.5 rounded-full bg-[#23c489]" />
            {lines.some((l) => !l.sim) ? "live" : "loop"}
          </span>
        </div>
        <div className="flex min-h-[150px] flex-1 flex-col justify-end gap-1 px-3 py-2.5 font-mono text-[11px]">
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
        <div className="border-white/10 border-t px-3 py-2.5 text-[11px] text-white/40 leading-relaxed tracking-[-0.01em]">
          Lenny interviews <span className="text-white/70">Elena Verna</span> —
          Head of Growth at{" "}
          <span className="inline-flex items-baseline gap-1 text-white/70">
            <LovableMark className="h-2.5 w-2.5 self-center" />
            Lovable
          </span>
          . Played through our own{" "}
          <code className="text-white/60">@hogsend/video</code>; press play and
          the real watch-depth events replace the loop.{" "}
          <Link href="/components" className="font-medium text-white/70">
            All our React components →
          </Link>
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

/** Player + capture to the docs Hogsend client (provider wraps the app root). */
function CapturingPlayer({ onEvent }: { onEvent: (e: VideoEvent) => void }) {
  const { capture } = useHogsend();
  const [emitter] = useState<VideoEmitter>(() =>
    createHogsendEmitter({ capture }),
  );
  return <Player emitter={emitter} onEvent={onEvent} />;
}

function Player({
  emitter,
  onEvent,
}: {
  emitter?: VideoEmitter;
  onEvent: (e: VideoEvent) => void;
}) {
  return (
    <VideoPlayer
      src={{ youtube: VIDEO_ID }}
      title={VIDEO_TITLE}
      emitter={emitter}
      onEvent={onEvent}
      context={{ section: "why-now", page: "landing" }}
      autoplay
      className="absolute inset-0 h-full w-full [&>iframe]:h-full [&>iframe]:w-full"
    />
  );
}
