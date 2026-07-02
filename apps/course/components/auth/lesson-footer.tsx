"use client";

import Link from "next/link";
import { useState } from "react";
import { celebrate, celebrateBig } from "@/components/course/celebrate";
import { useMounted } from "@/components/course/use-mounted";
import { useSession } from "@/lib/auth-client";

/**
 * End-of-lesson completion + what's-next moment. The lesson page passes the
 * server-known completed state (no flash) and the next chapter in course
 * order; marking complete celebrates with confetti and flips straight into
 * the bold next-chapter CTA. The final chapter gets the bigger burst and a
 * course-complete send-off. Shown only to signed-in readers (client session
 * read, so free/static lessons stay static for anon). Renders nothing until
 * mounted: the session store can resolve before React hydrates, and branching
 * on it during hydration mismatches the SSR HTML.
 */
export function LessonFooter({
  course,
  lesson,
  completed = false,
  next = null,
}: {
  course: string;
  lesson: string;
  /** Server-known: this reader already completed this lesson. */
  completed?: boolean;
  /** The following chapter in course order, or null on the last one. */
  next?: { url: string; title: string } | null;
}) {
  const mounted = useMounted();
  const { data: session, isPending } = useSession();
  const [state, setState] = useState<"idle" | "saving" | "done" | "error">(
    completed ? "done" : "idle",
  );

  if (!mounted || isPending || !session) return null;

  async function mark() {
    setState("saving");
    try {
      const res = await fetch("/api/progress", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ course, lesson }),
      });
      if (res.ok) {
        setState("done");
        if (next) celebrate();
        else celebrateBig();
      } else {
        setState("error");
      }
    } catch {
      setState("error");
    }
  }

  const done = state === "done";

  return (
    <section
      aria-label="Chapter completion"
      className={
        done
          ? "mt-8 rounded-md border border-good/40 bg-good-tint p-6"
          : "mt-8 rounded-md border border-white/[0.08] bg-white/[0.015] p-6"
      }
    >
      {done ? (
        <div>
          <p className="font-display text-white text-xl tracking-[-0.02em]">
            ✓ Chapter complete{next ? "" : " — that's the whole course"}
          </p>
          {next ? (
            <>
              <p className="mt-1.5 text-sm text-white/60">
                Nice work. Keep the momentum:
              </p>
              <Link
                href={next.url}
                className="mt-4 inline-flex h-11 items-center rounded-[10px] bg-accent px-5 font-medium text-sm text-white transition-colors hover:bg-accent-deep"
              >
                Next: {next.title} →
              </Link>
            </>
          ) : (
            <>
              <p className="mt-1.5 text-sm text-white/60">
                Everything you wrote along the way is your growth plan now.
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <Link
                  href="/workbook"
                  className="inline-flex h-11 items-center rounded-[10px] bg-accent px-5 font-medium text-sm text-white transition-colors hover:bg-accent-deep"
                >
                  Open your workbook →
                </Link>
                <Link
                  href={`/${course}`}
                  className="inline-flex h-11 items-center rounded-[10px] border border-white/[0.12] bg-white/[0.03] px-5 font-medium text-sm text-white transition-colors hover:border-white/30"
                >
                  Course overview
                </Link>
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="font-display text-lg text-white tracking-[-0.02em]">
              Done with this chapter?
            </p>
            <p className="mt-1 text-sm text-white/55">
              Mark it complete to keep your course progress honest.
            </p>
          </div>
          <div className="flex items-center gap-3">
            {state === "error" ? (
              <span className="text-accent text-sm">
                Couldn't save — try again.
              </span>
            ) : null}
            <button
              type="button"
              onClick={mark}
              disabled={state === "saving"}
              className="h-11 rounded-[10px] bg-accent px-5 font-medium text-sm text-white transition-colors hover:bg-accent-deep disabled:opacity-60"
            >
              {state === "saving" ? "Saving…" : "Mark chapter complete ✓"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
