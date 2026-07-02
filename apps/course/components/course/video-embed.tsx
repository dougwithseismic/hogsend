"use client";

import { useState } from "react";

/**
 * Privacy-light YouTube embed: renders the static thumbnail with a play
 * affordance and only mounts the (youtube-nocookie) iframe on click, so a
 * lesson with several videos loads no third-party script until the reader
 * opts in. Caption carries the verified title/channel so the block is useful
 * even unplayed.
 */
export function VideoEmbed({
  id,
  title,
  channel,
  duration,
  note,
}: {
  /** YouTube video id (11 chars). */
  id: string;
  title: string;
  channel: string;
  duration?: string;
  /** One line on why this video is worth the reader's time. */
  note?: string;
}) {
  const [playing, setPlaying] = useState(false);

  return (
    <figure className="not-prose my-8">
      <div className="relative aspect-video overflow-hidden rounded-md border border-white/[0.08] bg-black">
        {playing ? (
          <iframe
            src={`https://www.youtube-nocookie.com/embed/${id}?autoplay=1`}
            title={title}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowFullScreen
            className="absolute inset-0 h-full w-full"
          />
        ) : (
          <button
            type="button"
            onClick={() => setPlaying(true)}
            aria-label={`Play video: ${title}`}
            className="group absolute inset-0 h-full w-full"
          >
            {/* biome-ignore lint/performance/noImgElement: remote YouTube thumbnail; next/image optimization buys nothing here */}
            <img
              src={`https://i.ytimg.com/vi/${id}/hqdefault.jpg`}
              alt=""
              loading="lazy"
              className="absolute inset-0 h-full w-full object-cover opacity-80 transition-opacity group-hover:opacity-100"
            />
            <span className="absolute inset-0 flex items-center justify-center">
              <span className="flex h-14 w-20 items-center justify-center rounded-xl bg-black/70 transition-colors group-hover:bg-accent">
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  className="h-7 w-7 fill-white"
                >
                  <path d="M8 5.5v13l11-6.5-11-6.5z" />
                </svg>
              </span>
            </span>
            {duration ? (
              <span className="absolute right-2 bottom-2 rounded bg-black/80 px-1.5 py-0.5 font-medium text-white text-xs">
                {duration}
              </span>
            ) : null}
          </button>
        )}
      </div>
      <figcaption className="mt-2.5 text-sm">
        <span className="font-medium text-white">{title}</span>
        <span className="text-white/50"> — {channel}</span>
        {note ? (
          <span className="mt-1 block text-white/50 leading-relaxed">
            {note}
          </span>
        ) : null}
      </figcaption>
    </figure>
  );
}
