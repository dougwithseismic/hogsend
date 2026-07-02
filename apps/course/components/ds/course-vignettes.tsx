import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Static DOM vignettes of the real course UI — quiz, flashcard, workbook
 * note, plan checklist, chapter list — for marketing cards and CTA media.
 * They echo the interactive components in components/course/* (same panels,
 * hairlines, micro-labels) but render fixed, believable content with no
 * client code. Server-safe; there are no image assets in this app.
 */

const PANEL = "rounded-md border border-white/[0.08] bg-[#0a0606] p-5";

/**
 * The red radial-glow media frame shared by the catalog course cards and the
 * "what's inside" feature cards: a dark panel with a warm glow rising from
 * below. Callers size it (min-h) and position their own children — a cropped
 * vignette, a coming-soon pill. aria-hidden — everything it shows is repeated
 * accessibly in the card body.
 */
export function GlowMedia({
  className,
  children,
}: {
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div
      aria-hidden="true"
      className={cn("relative overflow-hidden bg-[#0a0606]", className)}
    >
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(85% 70% at 50% 115%, rgba(246,72,56,0.35), rgba(246,72,56,0.08) 55%, transparent 80%)",
          filter: "blur(24px)",
        }}
      />
      {children}
    </div>
  );
}
const MICRO_LABEL =
  "font-medium text-[11px] text-accent uppercase tracking-[0.14em]";

type VignetteProps = { className?: string };

/** A quiz question mid-answer: three options, the correct pick lit accent. */
export function QuizVignette({ className }: VignetteProps) {
  const options = [
    { text: "Signed up", state: "idle" },
    { text: "Created their first project", state: "picked" },
    { text: "Opened the pricing page", state: "idle" },
  ];

  return (
    <div className={cn(PANEL, className)}>
      <p className={MICRO_LABEL}>Quiz</p>
      <p className="mt-2 text-sm text-white leading-relaxed">
        Which event should count as activation for a project-management tool?
      </p>
      <div className="mt-3 flex flex-col gap-1.5">
        {options.map((option, oi) => (
          <div
            key={option.text}
            className={cn(
              "rounded-md border px-3 py-2 text-left text-[13px]",
              option.state === "picked"
                ? "border-accent/60 bg-accent-tint text-white"
                : "border-white/[0.08] bg-white/[0.01] text-white/45",
            )}
          >
            <span className="mr-2 text-white/40">
              {String.fromCharCode(65 + oi)}
            </span>
            {option.text}
          </div>
        ))}
      </div>
      <p className="mt-3 font-medium text-accent text-xs">
        ✓ Right — the first moment of real value, not the signup.
      </p>
    </div>
  );
}

/** A cloze flashcard front: width-true underlined blank, unflipped. */
export function FlashcardVignette({ className }: VignetteProps) {
  return (
    <div className={cn(PANEL, className)}>
      <p className={MICRO_LABEL}>Flashcards</p>
      <div className="mt-3 rounded-md border border-white/[0.1] bg-white/[0.02] p-4">
        <p className="font-medium text-[10px] text-white/35 uppercase tracking-[0.14em]">
          Fill the blanks — tap to reveal
        </p>
        <p className="mt-2 text-sm text-white/85 leading-relaxed">
          Fix{" "}
          <span className="select-none border-white/40 border-b text-transparent">
            retention
          </span>{" "}
          before acquisition — a leaky bucket wastes every new signup.
        </p>
      </div>
      <p className="mt-3 text-white/35 text-xs">
        Think of the answer, then tap the card.
      </p>
    </div>
  );
}

/** A workbook prompt with a saved answer — the written-exercise state. */
export function WorkbookVignette({ className }: VignetteProps) {
  return (
    <div className={cn(PANEL, className)}>
      <p className={MICRO_LABEL}>Workbook</p>
      <p className="mt-2 font-medium text-sm text-white">
        Write your activation sentence — the one action that means "got real
        value".
      </p>
      <div className="mt-3 rounded-md border border-white/[0.12] bg-white/[0.02] px-3 py-2 text-[13px] text-white/80 leading-relaxed">
        A user is activated when they've created a project and invited one
        teammate.
      </div>
      <p className="mt-3 text-good text-xs">✓ Saved to your workbook</p>
    </div>
  );
}

/** A slice of the day-30 plan checklist: three items, one ticked. */
export function PlanVignette({ className }: VignetteProps) {
  const items = [
    { text: "Your one activation event defined and firing", done: true },
    { text: "Tracking plan written down and shared", done: false },
    { text: "Daily dashboard built and pinned", done: false },
  ];

  return (
    <div className={cn(PANEL, className)}>
      <div className="flex items-baseline justify-between gap-3">
        <p className="font-medium text-sm text-white">Days 1–30 — Measure</p>
        <span className="whitespace-nowrap text-white/50 text-xs">
          1/3 done
        </span>
      </div>
      <ul className="mt-3 flex flex-col gap-2">
        {items.map((item) => (
          <li key={item.text} className="flex items-start gap-2.5">
            <span
              aria-hidden="true"
              className={cn(
                "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px]",
                item.done
                  ? "border-good/60 bg-good-tint text-good"
                  : "border-white/25 text-transparent",
              )}
            >
              ✓
            </span>
            <span
              className={cn(
                "text-[13px]",
                item.done ? "text-white/40 line-through" : "text-white/80",
              )}
            >
              {item.text}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The opening chapters of the flagship course, first one complete. */
export function ChapterListVignette({ className }: VignetteProps) {
  const chapters = [
    { n: "00", title: "Start here — product-led growth", done: true },
    { n: "01", title: "What PostHog is, and why you want it", done: false },
    { n: "02", title: "AARRR and the leaky bucket", done: false },
    { n: "03", title: "Instrument PostHog from zero", done: false },
  ];

  return (
    <div className={cn(PANEL, "p-0", className)}>
      <ul className="flex flex-col divide-y divide-white/[0.06]">
        {chapters.map((chapter) => (
          <li
            key={chapter.n}
            className="flex items-center gap-3 px-5 py-3 text-[13px]"
          >
            <span className="font-mono text-white/40 text-xs">{chapter.n}</span>
            <span className={chapter.done ? "text-white/45" : "text-white/80"}>
              {chapter.title}
            </span>
            {chapter.done ? (
              <span className="ml-auto text-good text-xs">✓</span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
