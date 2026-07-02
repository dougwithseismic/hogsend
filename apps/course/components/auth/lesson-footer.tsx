"use client";

import { useState } from "react";
import { useMounted } from "@/components/course/use-mounted";
import { useSession } from "@/lib/auth-client";

/** "Mark lesson complete" — shown only to signed-in readers (client session
 *  read, so free/static lessons stay static). POSTs to /api/progress, which
 *  records progress and fires course.lesson_completed / course.completed.
 *  Renders nothing until mounted: the session store can resolve before React
 *  hydrates, and branching on it during hydration mismatches the SSR HTML. */
export function LessonFooter({
  course,
  lesson,
}: {
  course: string;
  lesson: string;
}) {
  const mounted = useMounted();
  const { data: session, isPending } = useSession();
  const [state, setState] = useState<"idle" | "saving" | "done" | "error">(
    "idle",
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
      setState(res.ok ? "done" : "error");
    } catch {
      setState("error");
    }
  }

  return (
    <div className="mt-12 flex items-center gap-3 border-hairline-faint border-t pt-6">
      {state === "done" ? (
        <span className="text-good text-sm">✓ Lesson marked complete</span>
      ) : (
        <button
          type="button"
          onClick={mark}
          disabled={state === "saving"}
          className="h-10 rounded-[10px] border border-white/[0.12] bg-white/[0.03] px-4 font-medium text-sm text-white transition-colors hover:border-white/30 disabled:opacity-60"
        >
          {state === "saving" ? "Saving…" : "Mark lesson complete"}
        </button>
      )}
      {state === "error" ? (
        <span className="text-accent text-sm">Couldn't save — try again.</span>
      ) : null}
      <a
        href="/workbook"
        className="ml-auto text-sm text-white/50 underline transition-colors hover:text-white"
      >
        Your workbook →
      </a>
    </div>
  );
}
