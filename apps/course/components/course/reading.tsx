"use client";

import Link from "next/link";
import { useState } from "react";
import { celebrate } from "@/components/course/celebrate";
import { useMounted } from "@/components/course/use-mounted";
import { useWorkbookResponse } from "@/components/course/workbook-state";
import { useSession } from "@/lib/auth-client";

export type Book = {
  /** Book (or resource) title. */
  title: string;
  /** Author(s). */
  author?: string;
  /** One line on why it's worth reading, in the course voice. */
  why?: string;
  /** Where to find it (publisher/author page — never a pirated copy). */
  url?: string;
};

/**
 * A curated reading list as an interactive block: each book can be ticked
 * "read", and the set persists for signed-in readers (`reading:<id>`), counting
 * toward the workbook the same way a checklist or flashcard deck does. Signed-out
 * readers get the list (and can tick locally) with a sign-in hint. The books
 * themselves live in the MDX so a lesson curates its own shelf; the component
 * only owns the ticking + persistence.
 */
export function Reading({
  id,
  title = "Reading list",
  books,
}: {
  id: string;
  title?: string;
  books: Book[];
}) {
  const mounted = useMounted();
  const { data: session } = useSession();
  const { value, save } = useWorkbookResponse<{
    read?: number[];
    total?: number;
    title?: string;
  }>("reading", id, `reading:${id}`);

  const [read, setRead] = useState<number[]>(() =>
    (value?.read ?? []).filter(
      (n) => Number.isInteger(n) && n >= 0 && n < books.length,
    ),
  );

  function toggle(index: number) {
    setRead((prev) => {
      const next = prev.includes(index)
        ? prev.filter((n) => n !== index)
        : [...prev, index];
      if (session) {
        void save({ read: next, total: books.length, title });
        if (next.length === books.length && books.length > 0) celebrate();
      }
      return next;
    });
  }

  return (
    <div
      id={`wb-${id}`}
      className="not-prose my-8 scroll-mt-28 rounded-md border border-white/[0.08] bg-white/[0.015] p-5"
    >
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <p className="font-medium text-[11px] text-accent uppercase tracking-[0.14em]">
            Reading list
          </p>
          <p className="mt-2 font-medium text-base text-white">{title}</p>
        </div>
        <span className="whitespace-nowrap text-sm text-white/50">
          {read.length}/{books.length} read
        </span>
      </div>

      <ul className="mt-4 flex flex-col divide-y divide-white/[0.06]">
        {books.map((book, i) => {
          const done = read.includes(i);
          return (
            <li
              key={`${book.title}-${book.author ?? ""}`}
              className="flex items-start gap-3 py-3"
            >
              <button
                type="button"
                aria-pressed={done}
                aria-label={`Mark "${book.title}" read`}
                onClick={() => toggle(i)}
                className={
                  done
                    ? "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border border-good/60 bg-good-tint text-[11px] text-good"
                    : "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border border-white/25 text-transparent transition-colors hover:border-white/45"
                }
              >
                ✓
              </button>
              <div className="min-w-0 flex-1">
                <p className="text-sm text-white/90">
                  {book.url ? (
                    <a
                      href={book.url}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium underline decoration-white/25 underline-offset-2 transition-colors hover:decoration-white"
                    >
                      {book.title}
                    </a>
                  ) : (
                    <span className="font-medium">{book.title}</span>
                  )}
                  {book.author ? (
                    <span className="text-white/45"> — {book.author}</span>
                  ) : null}
                </p>
                {book.why ? (
                  <p className="mt-0.5 text-sm text-white/55 leading-relaxed">
                    {book.why}
                  </p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>

      {mounted && !session ? (
        <p className="mt-4 text-white/45 text-xs">
          <Link href="/sign-in" className="underline hover:text-white">
            Sign in free
          </Link>{" "}
          to save what you've read across visits.
        </p>
      ) : null}
    </div>
  );
}
