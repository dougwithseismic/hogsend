"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { celebrate } from "@/components/course/celebrate";
import { useMounted } from "@/components/course/use-mounted";
import { useWorkbookResponse } from "@/components/course/workbook-state";
import { useSession } from "@/lib/auth-client";

export type FlashCard = {
  /** The prompt side — a term or question. */
  front: string;
  /** The answer side — the fact, dense and complete. */
  back: string;
};

/**
 * A chapter's key facts as a flip-deck: tap to reveal the back, then "Got it"
 * retires the card and "Again" sends it to the back of the queue. Mastered
 * card indices persist for signed-in readers (`flashcards:<id>`), so a
 * half-studied deck resumes where it left off, and mastering the whole deck
 * celebrates + fires course.flashcards_completed. Signed-out readers get the
 * full study loop, local-only, with a sign-in hint.
 */
export function Flashcards({
  id,
  title = "Flashcards",
  cards,
}: {
  id: string;
  title?: string;
  cards: FlashCard[];
}) {
  const mounted = useMounted();
  const { data: session } = useSession();
  const { value, save } = useWorkbookResponse<{
    mastered?: number[];
    total?: number;
    title?: string;
  }>("flashcards", id, `flashcards:${id}`);

  const [queue, setQueue] = useState<number[]>([]);
  const [mastered, setMastered] = useState<Set<number>>(new Set());
  const [flipped, setFlipped] = useState(false);
  const [ready, setReady] = useState(false);

  // Restore mastered cards once on mount (the store is server-fed, so the
  // saved value is available synchronously; indices are re-validated in case
  // the deck was edited since).
  // biome-ignore lint/correctness/useExhaustiveDependencies: restore once per mount
  useEffect(() => {
    const restored = new Set(
      (value?.mastered ?? []).filter(
        (n) => Number.isInteger(n) && n >= 0 && n < cards.length,
      ),
    );
    setMastered(restored);
    setQueue(cards.map((_, i) => i).filter((i) => !restored.has(i)));
    setReady(true);
  }, []);

  const current = queue[0];
  const allDone = ready && queue.length === 0 && cards.length > 0;

  function persist(nextMastered: Set<number>) {
    if (!session) return;
    void save({
      mastered: [...nextMastered].sort((a, b) => a - b),
      total: cards.length,
      title,
    });
  }

  function gotIt() {
    if (current === undefined) return;
    const nextMastered = new Set(mastered).add(current);
    const nextQueue = queue.slice(1);
    setMastered(nextMastered);
    setQueue(nextQueue);
    setFlipped(false);
    persist(nextMastered);
    if (nextQueue.length === 0) celebrate();
  }

  function again() {
    if (current === undefined) return;
    setQueue([...queue.slice(1), current]);
    setFlipped(false);
  }

  function reset() {
    setMastered(new Set());
    setQueue(cards.map((_, i) => i));
    setFlipped(false);
    if (session) {
      void save({ mastered: [], total: cards.length, title });
    }
  }

  return (
    <div
      id={`wb-${id}`}
      className="not-prose my-8 scroll-mt-28 rounded-md border border-white/[0.08] bg-white/[0.015] p-5"
    >
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <p className="font-medium text-[11px] text-accent uppercase tracking-[0.14em]">
            Flashcards
          </p>
          <p className="mt-2 font-medium text-base text-white">{title}</p>
        </div>
        <span className="whitespace-nowrap text-sm text-white/50">
          {mastered.size}/{cards.length} mastered
        </span>
      </div>

      {!ready ? (
        <p className="mt-4 text-sm text-white/40">
          {cards.length} cards — tap to flip.
        </p>
      ) : allDone ? (
        <div className="mt-5 rounded-md border border-good/30 bg-good-tint p-4 text-center">
          <p className="font-medium text-good text-sm">
            Deck mastered — all {cards.length} cards ✓
          </p>
          <button
            type="button"
            onClick={reset}
            className="mt-3 h-9 rounded-[10px] border border-white/[0.12] bg-white/[0.03] px-4 font-medium text-sm text-white transition-colors hover:border-white/30"
          >
            Study again
          </button>
        </div>
      ) : current !== undefined ? (
        <div className="mt-5">
          <button
            type="button"
            onClick={() => setFlipped((f) => !f)}
            aria-pressed={flipped}
            className="block min-h-28 w-full rounded-md border border-white/[0.1] bg-white/[0.02] p-5 text-left transition-colors hover:border-white/25"
          >
            <p className="font-medium text-[10px] text-white/35 uppercase tracking-[0.14em]">
              {flipped ? "Answer" : "Tap to flip"}
            </p>
            <p
              className={
                flipped
                  ? "mt-2 text-sm text-white/85 leading-relaxed"
                  : "mt-2 font-medium text-base text-white leading-relaxed"
              }
            >
              {flipped ? cards[current].back : cards[current].front}
            </p>
          </button>
          {flipped ? (
            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                onClick={gotIt}
                className="h-9 rounded-[10px] bg-accent px-4 font-medium text-sm text-white transition-colors hover:bg-accent-deep"
              >
                Got it ✓
              </button>
              <button
                type="button"
                onClick={again}
                className="h-9 rounded-[10px] border border-white/[0.12] bg-white/[0.03] px-4 font-medium text-sm text-white/80 transition-colors hover:border-white/30"
              >
                Again ↻
              </button>
              <span className="ml-auto text-white/35 text-xs">
                {queue.length} to go
              </span>
            </div>
          ) : (
            <p className="mt-3 text-white/35 text-xs">
              Think of the answer, then tap the card.
            </p>
          )}
        </div>
      ) : null}

      {mounted && !session ? (
        <p className="mt-4 text-white/45 text-xs">
          <Link href="/sign-in" className="underline hover:text-white">
            Sign in free
          </Link>{" "}
          to save your progress across visits.
        </p>
      ) : null}
    </div>
  );
}
