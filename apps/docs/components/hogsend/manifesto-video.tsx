"use client";

import { useHogsend } from "@hogsend/react";
import type { VideoEmitter, VideoEvent } from "@hogsend/video";
import { createHogsendEmitter } from "@hogsend/video/hogsend";
import { VideoPlayer } from "@hogsend/video/react";
import { useCallback, useMemo, useState } from "react";
import { cn } from "@/lib/cn";
import { isHogsendConfigured } from "./config";

const VIDEO_ID = "6qAB6aUMIeA";
const VIDEO_TITLE = "Lenny's Podcast — the rise of growth engineering";

/**
 * The "Why now" video: Lenny's growth-engineering episode played through our
 * own @hogsend/video player, with the emitted watch-depth events rendered
 * live next to it. Click-to-load (static thumbnail first) so the landing page
 * pulls no YouTube script until the visitor opts in. When the docs Hogsend
 * client is configured the same events also capture to the dogfood instance;
 * unconfigured (forks, previews) the local event log still works.
 */
export function ManifestoVideo() {
  const [playing, setPlaying] = useState(false);
  const [events, setEvents] = useState<
    { key: number; name: string; detail: string }[]
  >([]);

  const onEvent = useCallback((e: VideoEvent) => {
    const pct = Math.round(Number(e.properties.percentWatched ?? 0));
    const detail =
      e.name === "video.progress"
        ? `milestone ${String(e.properties.milestone)}%`
        : e.name === "video.seek"
          ? `${Math.round(Number(e.properties.from ?? 0))}s → ${Math.round(Number(e.properties.to ?? 0))}s`
          : `${pct}% watched`;
    setEvents((prev) =>
      [{ key: Date.now() + prev.length, name: e.name, detail }, ...prev].slice(
        0,
        6,
      ),
    );
  }, []);

  return (
    <div className="mx-auto mt-14 grid w-full max-w-[920px] gap-4 text-left md:grid-cols-[1fr_260px]">
      <div className="relative aspect-video overflow-hidden rounded-md border border-white/[0.08] bg-black">
        {playing ? (
          isHogsendConfigured ? (
            <CapturingPlayer onEvent={onEvent} />
          ) : (
            <LocalPlayer onEvent={onEvent} />
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

      <div className="flex min-h-0 flex-col">
        <p className="text-[13px] text-white/75 leading-relaxed">
          Lenny on the rise of the growth engineer.
        </p>
        <p className="mt-1.5 text-[12px] text-white/40 leading-relaxed">
          Played through our own{" "}
          <code className="font-mono text-white/60">@hogsend/video</code> — the
          watch-depth events it emits appear here as they fire.
        </p>
        <ul className="mt-3 flex flex-col gap-1 font-mono text-[11px]">
          {events.length === 0 ? (
            <li className="text-white/25">
              {playing ? "waiting for events…" : "press play to see events"}
            </li>
          ) : (
            events.map((e, i) => (
              <li
                key={e.key}
                className={cn(
                  "flex items-baseline justify-between gap-3 rounded border border-white/[0.06] bg-white/[0.02] px-2 py-1",
                  i === 0 ? "text-white/80" : "text-white/35",
                )}
              >
                <span>{e.name}</span>
                <span className="shrink-0">{e.detail}</span>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}

/** Player + capture to the docs Hogsend client (provider wraps the app root). */
function CapturingPlayer({ onEvent }: { onEvent: (e: VideoEvent) => void }) {
  const { capture } = useHogsend();
  const emitter = useMemo(() => createHogsendEmitter({ capture }), [capture]);
  return <Player emitter={emitter} onEvent={onEvent} />;
}

/** Player with the local event log only (Hogsend unconfigured). */
function LocalPlayer({ onEvent }: { onEvent: (e: VideoEvent) => void }) {
  return <Player onEvent={onEvent} />;
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
