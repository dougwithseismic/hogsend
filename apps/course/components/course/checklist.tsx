"use client";

import { useEffect, useState } from "react";
import { useLesson } from "@/components/course/lesson-context";
import { getResponse, saveResponse } from "@/components/course/responses";
import { useMounted } from "@/components/course/use-mounted";
import { useSession } from "@/lib/auth-client";

/**
 * A persistent to-do list for the plan lessons (30/60/90/180-day horizons).
 * Signed-in readers' ticks survive across visits (saved per checklist id);
 * signed-out readers get local-only state and a hint to sign in.
 */
export function Checklist({
  id,
  title,
  items,
}: {
  id: string;
  title?: string;
  items: string[];
}) {
  const mounted = useMounted();
  const { data: session, isPending } = useSession();
  const lesson = useLesson();
  const [checked, setChecked] = useState<string[]>([]);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    getResponse<{ checked?: string[] }>(`checklist:${id}`).then((saved) => {
      if (cancelled) return;
      if (saved?.checked) {
        setChecked(saved.checked.filter((c) => items.includes(c)));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [session, id, items]);

  function toggle(item: string) {
    const next = checked.includes(item)
      ? checked.filter((c) => c !== item)
      : [...checked, item];
    setChecked(next);
    if (session) {
      void saveResponse(
        "checklist",
        id,
        { checked: next, ...(title ? { title } : {}) },
        lesson,
      );
    }
  }

  const done = checked.length;

  return (
    <div
      id={`wb-${id}`}
      className="not-prose my-8 scroll-mt-28 rounded-md border border-white/[0.08] bg-white/[0.015] p-5"
    >
      <div className="flex items-baseline justify-between gap-3">
        <p className="font-medium text-base text-white">
          {title ?? "Checklist"}
        </p>
        <span className="whitespace-nowrap text-sm text-white/50">
          {done}/{items.length} done
        </span>
      </div>
      <ul className="mt-4 flex flex-col gap-1">
        {items.map((item) => {
          const isDone = checked.includes(item);
          return (
            <li key={item}>
              <button
                type="button"
                onClick={() => toggle(item)}
                aria-pressed={isDone}
                className="group flex w-full items-start gap-3 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-white/[0.03]"
              >
                <span
                  aria-hidden
                  className={
                    isDone
                      ? "mt-0.5 flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded border border-good/60 bg-good-tint text-[11px] text-good"
                      : "mt-0.5 flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded border border-white/25 text-transparent group-hover:border-white/45"
                  }
                >
                  ✓
                </span>
                <span
                  className={
                    isDone
                      ? "text-sm text-white/40 line-through"
                      : "text-sm text-white/80"
                  }
                >
                  {item}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {mounted && !isPending && !session ? (
        <p className="mt-3 text-sm text-white/40">
          Sign in free to keep your progress across visits.
        </p>
      ) : null}
    </div>
  );
}
