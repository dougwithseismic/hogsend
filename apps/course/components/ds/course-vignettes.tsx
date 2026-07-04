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

/** Glow-backed media header for a FeatureCard — a vignette cropped like a
 *  screenshot over the red radial treatment (matches the course cards). */
export function VignetteMedia({ children }: { children: ReactNode }) {
  return (
    <GlowMedia className="min-h-[200px]">
      <div className="absolute inset-x-5 top-5">{children}</div>
    </GlowMedia>
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

/**
 * The hero's floating product window — a believable slice of the flagship
 * course under a browser-style chrome bar. Two panes: the syllabus with live
 * progress on the left, a self-check quiz with the right answer lit on the
 * right. The course analog of the product homepage's live-demo window.
 * aria-hidden — the hero copy and catalog below restate everything it shows.
 */
export function CoursePreviewWindow({
  className,
  chapterCount,
}: VignetteProps & {
  /** Real chapter total — derived by the caller, never hardcoded here. */
  chapterCount: number;
}) {
  const chapters = [
    { n: "00", title: "Start here — product-led growth", state: "done" },
    {
      n: "01",
      title: "What PostHog is, and why you want it",
      state: "reading",
    },
    { n: "02", title: "AARRR and the leaky bucket", state: "idle" },
    { n: "03", title: "Instrument PostHog from zero", state: "idle" },
  ] as const;
  const options = [
    "They signed up",
    "They created their first project",
    "They opened the pricing page",
  ];
  const pickedIndex = 1;

  return (
    <div
      aria-hidden="true"
      className={cn(
        "mx-auto max-w-[1024px] overflow-hidden rounded-xl border border-white/15 bg-[#0a0606] shadow-2xl",
        className,
      )}
    >
      {/* Window chrome */}
      <div className="flex items-center justify-between border-white/10 border-b px-4 py-2.5">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-full bg-white/15" />
            <span className="size-2.5 rounded-full bg-white/15" />
            <span className="size-2.5 rounded-full bg-white/15" />
          </div>
          <span className="font-mono text-[11px] text-white/40 tracking-wide">
            course.hogsend.com — Growth with PostHog
          </span>
        </div>
        <span className="font-mono text-[11px] text-accent">
          Chapter 1 of {chapterCount}
        </span>
      </div>

      {/* Two panes — the syllabus, and a self-check. */}
      <div className="grid grid-cols-1 md:grid-cols-2 md:divide-x md:divide-white/10">
        {/* Left — the syllabus with live progress. */}
        <div className="p-5 md:p-6">
          <p className={MICRO_LABEL}>The syllabus</p>
          <ul className="mt-3 flex flex-col divide-y divide-white/[0.06]">
            {chapters.map((chapter) => (
              <li
                key={chapter.n}
                className="flex items-center gap-3 py-2.5 text-[13px]"
              >
                <span className="font-mono text-[11px] text-white/40">
                  {chapter.n}
                </span>
                <span
                  className={
                    chapter.state === "idle" ? "text-white/80" : "text-white/50"
                  }
                >
                  {chapter.title}
                </span>
                {chapter.state === "done" ? (
                  <span className="ml-auto text-good text-xs">✓</span>
                ) : chapter.state === "reading" ? (
                  <span className="ml-auto whitespace-nowrap rounded-full bg-accent-tint px-2 py-0.5 text-[10px] text-accent">
                    reading
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          <p className="mt-4 text-white/35 text-xs">
            {chapterCount} chapters · the first two chapters are free
          </p>
        </div>

        {/* Right — a self-check quiz, the right answer lit. */}
        <div className="bg-white/[0.03] p-5 md:p-6">
          <p className={MICRO_LABEL}>Check yourself</p>
          <p className="mt-2 text-sm text-white leading-relaxed">
            Which event should count as activation for a project tool?
          </p>
          <div className="mt-3 flex flex-col gap-1.5">
            {options.map((text, oi) => (
              <div
                key={text}
                className={cn(
                  "rounded-md border px-3 py-2 text-left text-[13px]",
                  oi === pickedIndex
                    ? "border-accent/60 bg-accent-tint text-white"
                    : "border-white/[0.08] bg-white/[0.01] text-white/45",
                )}
              >
                <span className="mr-2 text-white/40">
                  {String.fromCharCode(65 + oi)}
                </span>
                {text}
              </div>
            ))}
          </div>
          <p className="mt-3 font-medium text-accent text-xs">
            ✓ Right — the first moment of real value, not the signup.
          </p>
        </div>
      </div>
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
