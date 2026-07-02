"use client";

import { useEffect, useState } from "react";
import { useLesson } from "@/components/course/lesson-context";
import { getResponse, saveResponse } from "@/components/course/responses";
import { useSession } from "@/lib/auth-client";

/**
 * A progressive-profiling block: one question about the READER (role, stack,
 * struggles, …), answered as choice pills and/or a short note. Saved answers
 * land on their Hogsend contact via /api/responses, so every check-in enriches
 * the profile the lifecycle journeys segment on. Signed-out readers can select
 * but not save — the save affordance becomes a sign-in link.
 *
 * `id` must exist in lib/profile.ts PROFILE_FIELDS (the API rejects unknowns).
 */
export function CheckIn({
  id,
  question,
  options = [],
  multi = false,
  freeText = false,
  notePlaceholder = "Anything you'd add? (optional)",
}: {
  id: string;
  question: string;
  options?: string[];
  multi?: boolean;
  freeText?: boolean;
  notePlaceholder?: string;
}) {
  const { data: session, isPending } = useSession();
  const lesson = useLesson();
  const [choices, setChoices] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">(
    "idle",
  );

  const key = `profile:${id}`;
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    getResponse<{ choices?: string[]; note?: string }>(key).then((saved) => {
      if (cancelled || !saved) return;
      setChoices(saved.choices ?? []);
      setNote(saved.note ?? "");
      setStatus("saved");
    });
    return () => {
      cancelled = true;
    };
  }, [session, key]);

  function toggle(option: string) {
    setStatus("idle");
    setChoices((prev) => {
      if (prev.includes(option)) return prev.filter((c) => c !== option);
      return multi ? [...prev, option] : [option];
    });
  }

  async function save() {
    setStatus("saving");
    const ok = await saveResponse(
      "profile",
      id,
      { choices, ...(note.trim() ? { note: note.trim() } : {}) },
      lesson,
    );
    setStatus(ok ? "saved" : "error");
  }

  const answered = choices.length > 0 || note.trim().length > 0;
  const signInHref = `/sign-in?next=${encodeURIComponent(
    lesson ? `/learn/${lesson.course}/${lesson.lesson}` : "/",
  )}`;

  return (
    <div className="not-prose my-8 rounded-md border border-white/[0.08] bg-white/[0.015] p-5">
      <p className="font-medium text-[11px] text-accent uppercase tracking-[0.14em]">
        Check-in
      </p>
      <p className="mt-2 font-medium text-base text-white">{question}</p>

      {options.length > 0 ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {options.map((option) => {
            const selected = choices.includes(option);
            return (
              <button
                key={option}
                type="button"
                onClick={() => toggle(option)}
                aria-pressed={selected}
                className={
                  selected
                    ? "rounded-full border border-accent/60 bg-accent-tint px-3.5 py-1.5 text-sm text-white transition-colors"
                    : "rounded-full border border-white/[0.12] bg-white/[0.03] px-3.5 py-1.5 text-sm text-white/80 transition-colors hover:border-white/30"
                }
              >
                {option}
              </button>
            );
          })}
        </div>
      ) : null}

      {freeText ? (
        <textarea
          value={note}
          onChange={(e) => {
            setNote(e.target.value);
            setStatus("idle");
          }}
          placeholder={notePlaceholder}
          maxLength={500}
          rows={2}
          className="mt-4 w-full resize-y rounded-md border border-white/[0.12] bg-white/[0.02] px-3 py-2 text-sm text-white placeholder:text-white/35 focus:border-white/30 focus:outline-none"
        />
      ) : null}

      <div className="mt-4 flex items-center gap-3">
        {isPending ? null : session ? (
          <>
            <button
              type="button"
              onClick={save}
              disabled={!answered || status === "saving"}
              className="h-9 rounded-[10px] border border-white/[0.12] bg-white/[0.03] px-4 font-medium text-sm text-white transition-colors hover:border-white/30 disabled:opacity-50"
            >
              {status === "saving"
                ? "Saving…"
                : status === "saved"
                  ? "Update answer"
                  : "Save answer"}
            </button>
            {status === "saved" ? (
              <span className="text-good text-sm">✓ Saved to your profile</span>
            ) : null}
            {status === "error" ? (
              <span className="text-accent text-sm">
                Couldn't save — try again.
              </span>
            ) : null}
          </>
        ) : (
          <a href={signInHref} className="text-sm text-white/60 underline">
            Sign in free to save your answer
          </a>
        )}
      </div>
    </div>
  );
}
