"use client";

import { useEffect, useState } from "react";
import { useLesson } from "@/components/course/lesson-context";
import { getResponse, saveResponse } from "@/components/course/responses";
import { useSession } from "@/lib/auth-client";

export type QuizQuestion = {
  q: string;
  options: string[];
  /** Index into options. */
  answer: number;
  explain?: string;
};

/**
 * End-of-lesson knowledge check. All questions answered at once, graded
 * locally on "Check answers" (per-question verdict + explanation + score),
 * then the score is persisted for signed-in readers (one row per lesson,
 * retakes overwrite) and fired to Hogsend as course.quiz_completed.
 */
export function Quiz({
  title = "Check your understanding",
  questions,
}: {
  title?: string;
  questions: QuizQuestion[];
}) {
  const { data: session } = useSession();
  const lesson = useLesson();
  const [picked, setPicked] = useState<Record<number, number>>({});
  const [graded, setGraded] = useState(false);
  const [lastScore, setLastScore] = useState<{
    score: number;
    total: number;
  } | null>(null);

  useEffect(() => {
    if (!session || !lesson) return;
    let cancelled = false;
    getResponse<{ score: number; total: number }>(
      `quiz:${lesson.course}/${lesson.lesson}`,
    ).then((saved) => {
      if (!cancelled && saved) setLastScore(saved);
    });
    return () => {
      cancelled = true;
    };
  }, [session, lesson]);

  const allAnswered = questions.every((_, i) => picked[i] !== undefined);
  const score = questions.reduce(
    (acc, q, i) => acc + (picked[i] === q.answer ? 1 : 0),
    0,
  );

  async function check() {
    setGraded(true);
    if (session && lesson) {
      const value = { score, total: questions.length };
      const ok = await saveResponse("quiz", "quiz", value, lesson);
      if (ok) setLastScore(value);
    }
  }

  function reset() {
    setPicked({});
    setGraded(false);
  }

  return (
    <div className="not-prose my-8 rounded-md border border-white/[0.08] bg-white/[0.015] p-5">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <p className="font-medium text-[11px] text-accent uppercase tracking-[0.14em]">
            Quiz
          </p>
          <p className="mt-2 font-medium text-base text-white">{title}</p>
        </div>
        {lastScore && !graded ? (
          <span className="whitespace-nowrap text-sm text-white/50">
            Last time: {lastScore.score}/{lastScore.total}
          </span>
        ) : null}
      </div>

      <ol className="mt-5 flex flex-col gap-6">
        {questions.map((q, qi) => {
          const chosen = picked[qi];
          return (
            <li key={q.q}>
              <p className="text-sm text-white">
                <span className="mr-2 text-white/40">{qi + 1}.</span>
                {q.q}
              </p>
              <div className="mt-2.5 flex flex-col gap-1.5">
                {q.options.map((option, oi) => {
                  const selected = chosen === oi;
                  const isAnswer = q.answer === oi;
                  let cls =
                    "rounded-md border px-3 py-2 text-left text-sm transition-colors ";
                  if (graded && isAnswer) {
                    cls += "border-good/60 bg-good-tint text-white";
                  } else if (graded && selected && !isAnswer) {
                    cls += "border-accent/60 bg-accent-tint text-white";
                  } else if (selected) {
                    cls += "border-white/40 bg-white/[0.06] text-white";
                  } else {
                    cls +=
                      "border-white/[0.1] bg-white/[0.02] text-white/75 hover:border-white/25";
                  }
                  return (
                    <button
                      key={option}
                      type="button"
                      disabled={graded}
                      onClick={() =>
                        setPicked((prev) => ({ ...prev, [qi]: oi }))
                      }
                      className={cls}
                    >
                      <span className="mr-2 text-white/40">
                        {String.fromCharCode(65 + oi)}
                      </span>
                      {option}
                    </button>
                  );
                })}
              </div>
              {graded && q.explain ? (
                <p className="mt-2 text-sm text-white/55 leading-relaxed">
                  {picked[qi] === q.answer ? "✓ " : "✗ "}
                  {q.explain}
                </p>
              ) : null}
            </li>
          );
        })}
      </ol>

      <div className="mt-6 flex items-center gap-3">
        {graded ? (
          <>
            <span className="font-medium text-sm text-white">
              {score}/{questions.length} correct
            </span>
            <button
              type="button"
              onClick={reset}
              className="h-9 rounded-[10px] border border-white/[0.12] bg-white/[0.03] px-4 font-medium text-sm text-white transition-colors hover:border-white/30"
            >
              Try again
            </button>
            {!session ? (
              <span className="text-sm text-white/50">
                Sign in to save your score.
              </span>
            ) : null}
          </>
        ) : (
          <button
            type="button"
            onClick={check}
            disabled={!allAnswered}
            className="h-9 rounded-[10px] border border-white/[0.12] bg-white/[0.03] px-4 font-medium text-sm text-white transition-colors hover:border-white/30 disabled:opacity-50"
          >
            Check answers
          </button>
        )}
      </div>
    </div>
  );
}
