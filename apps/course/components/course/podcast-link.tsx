"use client";

import { Headphones, Play } from "lucide-react";
import { useState } from "react";
import { MediaDoneToggle } from "@/components/course/media-toggle";
import { CopyLinkButton } from "@/components/course/share-link";

/**
 * A recommended podcast episode: title/show/why-it's-worth-it plus outbound
 * listen links (Spotify / YouTube / Apple — whichever are authored). When the
 * Spotify link is an episode, a "Play here" affordance mounts Spotify's embed
 * player in place (privacy-light: no third-party iframe until the reader opts
 * in — the VideoEmbed pattern). A listened tick persists to the workbook
 * (counts in the chapter recap), and everyone gets a share link.
 *
 * `id` is a stable kebab-case slug (it keys the media response row).
 */

/** open.spotify.com/episode/<id> (intl prefixes tolerated) → embed URL. */
function spotifyEmbedUrl(url?: string): string | null {
  if (!url) return null;
  const match = url.match(
    /open\.spotify\.com\/(?:intl-[a-z]{2}(?:-[A-Za-z]{2})?\/)?(episode|show)\/([A-Za-z0-9]+)/,
  );
  return match
    ? `https://open.spotify.com/embed/${match[1]}/${match[2]}`
    : null;
}

export function PodcastLink({
  id,
  title,
  show,
  guest,
  duration,
  note,
  spotify,
  youtube,
  apple,
}: {
  id: string;
  title: string;
  show: string;
  guest?: string;
  duration?: string;
  /** One line on why this episode is worth the reader's time. */
  note?: string;
  spotify?: string;
  youtube?: string;
  apple?: string;
}) {
  const [playing, setPlaying] = useState(false);
  const shareUrl = spotify ?? youtube ?? apple;
  const embedUrl = spotifyEmbedUrl(spotify);

  const links = [
    { label: "Spotify", href: spotify },
    { label: "YouTube", href: youtube },
    { label: "Apple", href: apple },
  ].filter((l): l is { label: string; href: string } => Boolean(l.href));

  return (
    <div
      id={`wb-media-${id}`}
      className="not-prose my-8 scroll-mt-28 rounded-md border border-white/[0.08] bg-white/[0.015] p-5"
    >
      <div className="flex items-start gap-3.5">
        <span
          aria-hidden
          className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-white/[0.1] bg-white/[0.03] text-white/60"
        >
          <Headphones className="size-4.5" strokeWidth={1.5} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-medium text-[11px] text-accent uppercase tracking-[0.14em]">
            Podcast
          </p>
          <p className="mt-1.5 font-medium text-sm text-white leading-snug">
            {title}
          </p>
          <p className="mt-0.5 text-sm text-white/50">
            {show}
            {guest ? ` — with ${guest}` : ""}
            {duration ? ` · ${duration}` : ""}
          </p>
          {note ? (
            <p className="mt-2 text-sm text-white/55 leading-relaxed">{note}</p>
          ) : null}

          {playing && embedUrl ? (
            <iframe
              src={embedUrl}
              title={`Play: ${title}`}
              allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
              loading="lazy"
              className="mt-3 h-[152px] w-full rounded-xl border-0"
            />
          ) : null}

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
            {embedUrl && !playing ? (
              <button
                type="button"
                onClick={() => setPlaying(true)}
                className="inline-flex items-center gap-1.5 rounded-full bg-accent px-3 py-1 font-medium text-white text-xs transition-colors hover:bg-accent-deep"
              >
                <Play
                  className="size-3 fill-white"
                  strokeWidth={0}
                  aria-hidden
                />
                Play here
              </button>
            ) : null}
            {links.map((link) => (
              <a
                key={link.label}
                href={link.href}
                target="_blank"
                rel="noreferrer"
                className="rounded-full border border-white/[0.12] bg-white/[0.03] px-3 py-1 text-white/80 text-xs transition-colors hover:border-white/30 hover:text-white"
              >
                {link.label} ↗
              </a>
            ))}
            <span className="ml-auto flex items-center gap-4">
              <MediaDoneToggle id={id} media="podcast" title={title} />
              {shareUrl ? (
                <CopyLinkButton url={shareUrl} label="Share" />
              ) : null}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
