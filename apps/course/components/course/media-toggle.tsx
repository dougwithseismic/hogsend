"use client";

import { useMounted } from "@/components/course/use-mounted";
import { useWorkbookResponse } from "@/components/course/workbook-state";
import { useSession } from "@/lib/auth-client";

/**
 * The shared watched/listened tick for media blocks (VideoEmbed, PodcastLink).
 * Signed-in only — persists a media response (counts in the chapter recap and
 * /workbook). Renders nothing for signed-out readers or before mount.
 */
export function MediaDoneToggle({
  id,
  media,
  title,
}: {
  id: string;
  media: "video" | "podcast";
  title?: string;
}) {
  const mounted = useMounted();
  const { data: session } = useSession();
  const { value, save } = useWorkbookResponse<{
    done?: boolean;
    media?: string;
    title?: string;
  }>("media", id, `media:${id}`);
  const done = value?.done === true;
  if (!mounted || !session) return null;

  const doneLabel = media === "podcast" ? "Listened" : "Watched";
  const todoLabel =
    media === "podcast" ? "Mark as listened" : "Mark as watched";

  return (
    <button
      type="button"
      aria-pressed={done}
      onClick={() =>
        void save({ done: !done, media, ...(title ? { title } : {}) })
      }
      className="inline-flex items-center gap-2 text-xs transition-colors"
    >
      <span
        aria-hidden
        className={
          done
            ? "flex h-4.5 w-4.5 items-center justify-center rounded border border-good/60 bg-good-tint text-[10px] text-good"
            : "flex h-4.5 w-4.5 items-center justify-center rounded border border-white/25 text-transparent hover:border-white/45"
        }
      >
        ✓
      </span>
      <span className={done ? "text-good" : "text-white/50"}>
        {done ? doneLabel : todoLabel}
      </span>
    </button>
  );
}
