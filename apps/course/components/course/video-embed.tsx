"use client";

import { useHogsend } from "@hogsend/react";
import { createHogsendEmitter } from "@hogsend/video/hogsend";
import { VideoPlayer } from "@hogsend/video/react";
import { useMemo, useState } from "react";
import { MediaDoneToggle } from "@/components/course/media-toggle";
import { CopyLinkButton } from "@/components/course/share-link";
import { isHogsendConfigured } from "@/components/hogsend/provider";

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

  return (
    <figure id={`wb-media-${id}`} className="not-prose my-8 scroll-mt-28">
      <div className="relative aspect-video overflow-hidden rounded-md border border-white/[0.08] bg-black">
        {playing ? (
          isHogsendConfigured ? (
            <TrackedYouTube id={id} title={title} channel={channel} />
          ) : (
            <iframe
              src={`https://www.youtube-nocookie.com/embed/${id}?autoplay=1`}
              title={title}
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
              allowFullScreen
              className="absolute inset-0 h-full w-full"
            />
          )
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
        <MediaDoneToggle id={id} media="video" title={title} />
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

/**
 * Same youtube-nocookie playback (IFrame API + enablejsapi), now emitting the
 * playbook's watch-depth contract — video.started / video.progress (25/50/75/90,
 * percentWatched) / video.completed — through the course's Hogsend client, so
 * anonymous watches fold into the contact on later identify. Only rendered when
 * Hogsend is configured AND the reader already clicked play, so the privacy
 * posture (no third-party script before opt-in) is unchanged.
 */
function TrackedYouTube({
  id,
  title,
  channel,
}: {
  id: string;
  title: string;
  channel: string;
}) {
  const { capture } = useHogsend();
  const emitter = useMemo(() => createHogsendEmitter({ capture }), [capture]);
  const context = useMemo(() => ({ channel, courseVideo: true }), [channel]);
  return (
    <VideoPlayer
      src={{ youtube: id }}
      title={title}
      emitter={emitter}
      context={context}
      autoplay
      className="absolute inset-0 h-full w-full [&>iframe]:h-full [&>iframe]:w-full"
    />
  );
}
