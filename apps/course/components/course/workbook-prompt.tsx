"use client";

import { useState } from "react";
import { useLesson } from "@/components/course/lesson-context";
import { useMounted } from "@/components/course/use-mounted";
import { useWorkbookResponse } from "@/components/course/workbook-state";
import { useSession } from "@/lib/auth-client";

/**
 * A written exercise: the reader answers in their own words (activation
 * sentence, tracking-plan draft, hypotheses, …) and the text is saved to their
 * workbook — reviewable any time at /workbook, linked back to this lesson.
 * `id` is a free kebab-case slug (notes don't write contact properties, so no
 * registry); the authored prompt is stored with the answer for display.
 */
export function WorkbookPrompt({
  id,
  prompt,
  placeholder,
  rows = 3,
}: {
  id: string;
  prompt: string;
  placeholder?: string;
  rows?: number;
}) {
  const mounted = useMounted();
  const { data: session, isPending } = useSession();
  const lesson = useLesson();
  const { value: saved, save: persist } = useWorkbookResponse<{
    text?: string;
    prompt?: string;
  }>("note", id, `note:${id}`);

  const [text, setText] = useState(saved?.text ?? "");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">(
    saved?.text ? "saved" : "idle",
  );

  async function save() {
    setStatus("saving");
    const ok = await persist({ text: text.trim(), prompt });
    setStatus(ok ? "saved" : "error");
  }

  const signInHref = `/sign-in?next=${encodeURIComponent(
    lesson ? `/learn/${lesson.course}/${lesson.lesson}` : "/",
  )}`;

  return (
    <div
      id={`wb-${id}`}
      className="not-prose my-8 scroll-mt-28 rounded-md border border-white/[0.08] bg-white/[0.015] p-5"
    >
      <p className="font-medium text-[11px] text-accent uppercase tracking-[0.14em]">
        Workbook
      </p>
      <p className="mt-2 font-medium text-base text-white">{prompt}</p>

      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setStatus("idle");
        }}
        placeholder={placeholder}
        maxLength={2000}
        rows={rows}
        className="mt-4 w-full resize-y rounded-md border border-white/[0.12] bg-white/[0.02] px-3 py-2 text-sm text-white leading-relaxed placeholder:text-white/35 focus:border-white/30 focus:outline-none"
      />

      <div className="mt-3 flex items-center gap-3">
        {!mounted || isPending ? null : session ? (
          <>
            <button
              type="button"
              onClick={save}
              disabled={!text.trim() || status === "saving"}
              className="h-9 rounded-[10px] border border-white/[0.12] bg-white/[0.03] px-4 font-medium text-sm text-white transition-colors hover:border-white/30 disabled:opacity-50"
            >
              {status === "saving"
                ? "Saving…"
                : status === "saved"
                  ? "Update"
                  : "Save to workbook"}
            </button>
            {status === "saved" ? (
              <span className="text-good text-sm">
                ✓ Saved —{" "}
                <a href="/workbook" className="underline">
                  view your workbook
                </a>
              </span>
            ) : null}
            {status === "error" ? (
              <span className="text-accent text-sm">
                Couldn't save — try again.
              </span>
            ) : null}
          </>
        ) : (
          <a href={signInHref} className="text-sm text-white/60 underline">
            Sign in free to save your work
          </a>
        )}
      </div>
    </div>
  );
}
