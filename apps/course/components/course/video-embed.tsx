"use client";

import { useState } from "react";
import { CopyLinkButton } from "@/components/course/share-link";
import { useMounted } from "@/components/course/use-mounted";
import { useWorkbookResponse } from "@/components/course/workbook-state";
import { useSession } from "@/lib/auth-client";

/**
 * Privacy-light YouTube embed: renders the static thumbnail with a play
 * affordance and only mounts the (youtube-nocookie) iframe on click, so a
 * lesson with several videos loads no third-party script until the reader
 * opts in. Caption carries the verified title/channel so the block is useful
 * even unplayed. Signed-in readers can tick it watched (persisted to the
 * workbook, counts in the chapter recap); everyone gets share links.
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
  const mounted = useMounted();
  const { data: session } = useSession();
  const { value, save } = useWorkbookResponse<{ done?: boolean }>(
    "media",
    id,
    `media:${id}`,
  );
  const watched = value?.done === true;

  return (
    <figure id={`wb-media-${id}`} className="not-prose my-8 scroll-mt-28">
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

      <div className="mt-2.5 flex items-center gap-4">
        {mounted && session ? (
          <button
            type="button"
            aria-pressed={watched}
            onClick={() => void save({ done: !watched })}
            className="inline-flex items-center gap-2 text-xs transition-colors"
          >
            <span
              aria-hidden
              className={
                watched
                  ? "flex h-4.5 w-4.5 items-center justify-center rounded border border-good/60 bg-good-tint text-[10px] text-good"
                  : "flex h-4.5 w-4.5 items-center justify-center rounded border border-white/25 text-transparent hover:border-white/45"
              }
            >
              ✓
            </span>
            <span className={watched ? "text-good" : "text-white/50"}>
              {watched ? "Watched" : "Mark as watched"}
            </span>
          </button>
        ) : null}
        <span className="ml-auto flex items-center gap-4">
          <CopyLinkButton url={`https://youtu.be/${id}`} label="Share" />
          <a
            href={`https://www.youtube.com/watch?v=${id}`}
            target="_blank"
            rel="noreferrer"
            className="text-white/50 text-xs transition-colors hover:text-white"
          >
            YouTube ↗
          </a>
        </span>
      </div>
    </figure>
  );
}
