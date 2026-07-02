"use client";

import { Headphones } from "lucide-react";
import { CopyLinkButton } from "@/components/course/share-link";
import { useMounted } from "@/components/course/use-mounted";
import { useWorkbookResponse } from "@/components/course/workbook-state";
import { useSession } from "@/lib/auth-client";

/**
 * A recommended podcast episode: title/show/why-it's-worth-it plus outbound
 * listen links (Spotify / YouTube / Apple — whichever are authored). No
 * embedded player — podcasts are a leave-the-page medium, so the block's job
 * is a clear recommendation, a listened tick that persists to the workbook
 * (counts in the chapter recap), and a share link.
 *
 * `id` is a stable kebab-case slug (it keys the media response row).
 */
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
  const mounted = useMounted();
  const { data: session } = useSession();
  const { value, save } = useWorkbookResponse<{ done?: boolean }>(
    "media",
    id,
    `media:${id}`,
  );
  const listened = value?.done === true;
  const shareUrl = spotify ?? youtube ?? apple;

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

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
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
              {mounted && session ? (
                <button
                  type="button"
                  aria-pressed={listened}
                  onClick={() => void save({ done: !listened })}
                  className="inline-flex items-center gap-2 text-xs transition-colors"
                >
                  <span
                    aria-hidden
                    className={
                      listened
                        ? "flex h-4.5 w-4.5 items-center justify-center rounded border border-good/60 bg-good-tint text-[10px] text-good"
                        : "flex h-4.5 w-4.5 items-center justify-center rounded border border-white/25 text-transparent hover:border-white/45"
                    }
                  >
                    ✓
                  </span>
                  <span className={listened ? "text-good" : "text-white/50"}>
                    {listened ? "Listened" : "Mark as listened"}
                  </span>
                </button>
              ) : null}
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
