"use client";

import { useState } from "react";
import { celebrate } from "@/components/course/celebrate";
import { useLesson } from "@/components/course/lesson-context";
import { useWorkbookResponse } from "@/components/course/workbook-state";
import { useSession } from "@/lib/auth-client";

export type QuizQuestion = {
  q: string;
  options: string[];
  /** Index into options. */
  answer: number;
  explain?: string;
};

/**
 * End-of-lesson knowledge check, one question at a time: pick an answer and
 * the verdict + explanation land immediately; a not-yet-answered question can
 * be swapped for a fresh one from the pool. Each run samples `count` questions
 * from the authored pool (so retakes get fresh questions), and the finale
 * celebrates with confetti and persists the score for signed-in readers
 * (retakes overwrite; fired to Hogsend as course.quiz_completed).
 */

/** Session state for one sampled question. */
type Slot = {
  /** Index into the authored pool. */
  qi: number;
  /** Chosen option index, or null while unanswered. */
  picked: number | null;
};

function sample(poolSize: number, count: number): number[] {
  const indices = Array.from({ length: poolSize }, (_, i) => i);
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return indices.slice(0, count);
}

function scoreLine(score: number, total: number): string {
  const pct = total > 0 ? score / total : 0;
  if (pct === 1) return "Perfect score — flawless.";
  if (pct >= 0.8) return "Great shout — you've got this chapter.";
  if (pct >= 0.6) return "Solid — worth a skim of what you missed.";
  return "Worth a re-run — the chapter's right above.";
}

export function Quiz({
  title = "Check your understanding",
  questions,
  count = 5,
}: {
  title?: string;
  questions: QuizQuestion[];
  /** Questions per run, sampled from the pool. */
  count?: number;
}) {
  const { data: session } = useSession();
  const lesson = useLesson();
  const { value: lastScore, save: persist } = useWorkbookResponse<{
    score: number;
    total: number;
  }>("quiz", "quiz", lesson ? `quiz:${lesson.course}/${lesson.lesson}` : "");

  const runLength = Math.min(count, questions.length);

  const [stage, setStage] = useState<"intro" | "run" | "done">("intro");
  const [slots, setSlots] = useState<Slot[]>([]);
  const [current, setCurrent] = useState(0);
  /** Pool indices used this run (sampled or swapped in) — no repeats. */
  const [used, setUsed] = useState<Set<number>>(new Set());
  const [saveFailed, setSaveFailed] = useState(false);

  const score = slots.reduce(
    (acc, slot) =>
      acc +
      (slot.picked !== null && slot.picked === questions[slot.qi].answer
        ? 1
        : 0),
    0,
  );

  function start() {
    const picked = sample(questions.length, runLength);
    setSlots(picked.map((qi) => ({ qi, picked: null })));
    setUsed(new Set(picked));
    setCurrent(0);
    setSaveFailed(false);
    setStage("run");
  }

  function pick(oi: number) {
    setSlots((prev) =>
      prev.map((slot, i) => (i === current ? { ...slot, picked: oi } : slot)),
    );
  }

  function swap() {
    const unused = questions.map((_, i) => i).filter((i) => !used.has(i));
    if (unused.length === 0) return;
    const next = unused[Math.floor(Math.random() * unused.length)];
    setUsed((prev) => new Set(prev).add(next));
    setSlots((prev) =>
      prev.map((slot, i) =>
        i === current ? { qi: next, picked: null } : slot,
      ),
    );
  }

  async function advance() {
    if (current < slots.length - 1) {
      setCurrent(current + 1);
      return;
    }
    setStage("done");
    celebrate();
    if (session && lesson) {
      const ok = await persist({ score, total: slots.length });
      setSaveFailed(!ok);
    }
  }

  const canSwap =
    stage === "run" && used.size < questions.length && slots.length > 0;

  return (
    <div
      id="wb-quiz"
      className="not-prose my-8 scroll-mt-28 rounded-md border border-white/[0.08] bg-white/[0.015] p-5"
    >
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <p className="font-medium text-[11px] text-accent uppercase tracking-[0.14em]">
            Quiz
          </p>
          <p className="mt-2 font-medium text-base text-white">{title}</p>
        </div>
        {lastScore && stage !== "done" ? (
          <span className="whitespace-nowrap text-sm text-white/50">
            Last time: {lastScore.score}/{lastScore.total}
          </span>
        ) : null}
      </div>

      {stage === "intro" ? (
        <div className="mt-5">
          <p className="text-sm text-white/55 leading-relaxed">
            {runLength} questions, one at a time, instant feedback
            {questions.length > runLength
              ? ` — drawn from a pool of ${questions.length}, so every run is different`
              : ""}
            .
          </p>
          <button
            type="button"
            onClick={start}
            className="mt-4 h-10 rounded-[10px] bg-accent px-5 font-medium text-sm text-white transition-colors hover:bg-accent-deep"
          >
            {lastScore ? "Take it again →" : "Start the quiz →"}
          </button>
        </div>
      ) : null}

      {stage === "run" && slots[current] ? (
        <QuizStep
          question={questions[slots[current].qi]}
          picked={slots[current].picked}
          index={current}
          slots={slots}
          questions={questions}
          onPick={pick}
          onSwap={canSwap ? swap : undefined}
          onNext={advance}
          isLast={current === slots.length - 1}
        />
      ) : null}

      {stage === "done" ? (
        <div className="mt-6 text-center">
          <p className="font-display text-4xl text-white tracking-[-0.02em]">
            {score}/{slots.length}
          </p>
          <p className="mt-2 font-medium text-base text-white">
            {scoreLine(score, slots.length)}
          </p>
          <p className="mt-1 text-sm text-white/50">
            {session
              ? saveFailed
                ? "Couldn't save your score — it will save on your next run."
                : "Score saved to your workbook."
              : "Sign in free to save your score."}
          </p>
          <div className="mt-5 flex items-center justify-center gap-3">
            <button
              type="button"
              onClick={start}
              className="h-10 rounded-[10px] border border-white/[0.12] bg-white/[0.03] px-5 font-medium text-sm text-white transition-colors hover:border-white/30"
            >
              {questions.length > runLength
                ? "Retake with fresh questions"
                : "Take it again"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function QuizStep({
  question,
  picked,
  index,
  slots,
  questions,
  onPick,
  onSwap,
  onNext,
  isLast,
}: {
  question: QuizQuestion;
  picked: number | null;
  index: number;
  slots: Slot[];
  questions: QuizQuestion[];
  onPick: (oi: number) => void;
  onSwap?: () => void;
  onNext: () => void;
  isLast: boolean;
}) {
  const answered = picked !== null;
  const correct = answered && picked === question.answer;

  return (
    <div className="mt-5">
      {/* Progress dots: green = right, red = wrong, white ring = current. */}
      <div className="flex items-center gap-1.5">
        {slots.map((slot, i) => {
          const slotAnswered = slot.picked !== null;
          const slotCorrect =
            slotAnswered && slot.picked === questions[slot.qi].answer;
          let cls = "h-1.5 rounded-full transition-all ";
          if (i === index) {
            cls += "w-6 bg-white";
          } else if (slotCorrect) {
            cls += "w-1.5 bg-good";
          } else if (slotAnswered) {
            cls += "w-1.5 bg-accent";
          } else {
            cls += "w-1.5 bg-white/20";
          }
          return <span key={`${slot.qi}`} className={cls} aria-hidden />;
        })}
        <span className="ml-2 text-white/40 text-xs">
          {index + 1}/{slots.length}
        </span>
      </div>

      <p className="mt-4 text-base text-white leading-relaxed">{question.q}</p>

      <div className="mt-3.5 flex flex-col gap-1.5">
        {question.options.map((option, oi) => {
          const selected = picked === oi;
          const isAnswer = question.answer === oi;
          let cls =
            "rounded-md border px-3 py-2.5 text-left text-sm transition-colors ";
          if (answered && isAnswer) {
            cls += "border-good/60 bg-good-tint text-white";
          } else if (answered && selected && !isAnswer) {
            cls += "border-accent/60 bg-accent-tint text-white";
          } else if (answered) {
            cls += "border-white/[0.08] bg-white/[0.01] text-white/45";
          } else {
            cls +=
              "border-white/[0.1] bg-white/[0.02] text-white/80 hover:border-white/30";
          }
          return (
            <button
              key={option}
              type="button"
              disabled={answered}
              onClick={() => onPick(oi)}
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

      {answered ? (
        <div className="mt-4">
          <p
            className={
              correct
                ? "font-medium text-good text-sm"
                : "font-medium text-accent text-sm"
            }
          >
            {correct ? "✓ Right." : "✗ Not this one."}
          </p>
          {question.explain ? (
            <p className="mt-1 text-sm text-white/55 leading-relaxed">
              {question.explain}
            </p>
          ) : null}
          <button
            type="button"
            onClick={onNext}
            className="mt-4 h-9 rounded-[10px] bg-accent px-4 font-medium text-sm text-white transition-colors hover:bg-accent-deep"
          >
            {isLast ? "See your score →" : "Next question →"}
          </button>
        </div>
      ) : onSwap ? (
        <button
          type="button"
          onClick={onSwap}
          className="mt-3 text-sm text-white/40 underline transition-colors hover:text-white/70"
        >
          Try a different question
        </button>
      ) : null}
    </div>
  );
}
