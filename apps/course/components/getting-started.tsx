import { eq } from "drizzle-orm";
import { Check } from "lucide-react";
import Link from "next/link";
import type { JSX } from "react";
import { Card } from "@/components/ds/card";
import { cn } from "@/lib/cn";
import { getCourseModules } from "@/lib/course-ui";
import { COURSES } from "@/lib/courses";
import { db } from "@/lib/db";
import { lessonProgress, response } from "@/lib/db/schema";
import { DISCORD_INVITE_URL } from "@/lib/site";

/**
 * The getting-started checklist: five "firsts" a new reader works through.
 * Four are DERIVED from rows the course already writes (lesson_progress +
 * response), so they tick themselves; the Discord one is a manual tick.
 * Manual ticks and dismissal persist as ONE response row (key
 * "checklist:getting-started" — the same shape the /api/responses checklist
 * kind produces), written by /api/getting-started via plain form POSTs, so
 * the card stays a server component with no client JS.
 */

export const GETTING_STARTED_KEY = "checklist:getting-started";
/** Sentinel stored in the row's `checked` array when the card is dismissed. */
export const DISMISSED_FLAG = "dismissed";
/** The only manually-tickable item ids (everything else is derived). */
export const MANUAL_ITEM_IDS = ["discord"] as const;

export type GettingStartedItem = {
  id: string;
  label: string;
  href: string;
  external?: boolean;
  /** Ticked by the reader (form POST), not derived from activity rows. */
  manual?: boolean;
  done: boolean;
};

export type GettingStartedState = {
  items: GettingStartedItem[];
  done: number;
  total: number;
  dismissed: boolean;
  complete: boolean;
  /** First unticked item, for the compact sidebar surface. */
  next: GettingStartedItem | null;
};

/** First lesson URL of the first published course (chapter 0). */
function firstLessonUrl(): string {
  const flagship = COURSES.find((c) => !c.comingSoon);
  if (!flagship) return "/";
  const first = getCourseModules(flagship.slug).flatMap((m) => m.lessons)[0];
  return first?.url ?? `/${flagship.slug}`;
}

/** Derive the reader's checklist state — two queries, zero new tables. */
export async function loadGettingStarted(
  userId: string,
): Promise<GettingStartedState> {
  const [progressRows, responseRows] = await Promise.all([
    db
      .select({ id: lessonProgress.id })
      .from(lessonProgress)
      .where(eq(lessonProgress.userId, userId))
      .limit(1),
    db
      .select({ key: response.key, kind: response.kind, value: response.value })
      .from(response)
      .where(eq(response.userId, userId)),
  ]);

  const own = responseRows.find((r) => r.key === GETTING_STARTED_KEY);
  const checked = new Set(
    ((own?.value as { checked?: string[] } | null)?.checked ?? []).filter(
      (c) => typeof c === "string",
    ),
  );
  // This card's own row never counts as a workbook answer.
  const activity = responseRows.filter((r) => r.key !== GETTING_STARTED_KEY);
  const hasKind = (...kinds: string[]) =>
    activity.some((r) => kinds.includes(r.kind));

  const items: GettingStartedItem[] = [
    {
      id: "first-chapter",
      label: "Read your first chapter",
      href: firstLessonUrl(),
      done: progressRows.length > 0,
    },
    {
      id: "first-workbook",
      label: "Save a workbook answer",
      href: "/workbook",
      done: hasKind("note", "profile", "checklist"),
    },
    {
      id: "first-quiz",
      label: "Take a chapter quiz",
      href: "/workbook",
      done: hasKind("quiz"),
    },
    {
      id: "flashcards",
      label: "Try the flashcards",
      href: "/workbook",
      done: hasKind("flashcards"),
    },
    {
      id: "discord",
      label: "Join the Discord",
      href: DISCORD_INVITE_URL,
      external: true,
      manual: true,
      done: checked.has("discord"),
    },
  ];

  const done = items.filter((i) => i.done).length;
  return {
    items,
    done,
    total: items.length,
    dismissed: checked.has(DISMISSED_FLAG),
    complete: done === items.length,
    next: items.find((i) => !i.done) ?? null,
  };
}

/** Hidden fields + submit for the form-POST ticks (no client JS needed). */
function TickForm({
  op,
  item,
  returnTo,
  children,
  className,
}: {
  op: "toggle" | "dismiss";
  item?: string;
  returnTo: string;
  children: React.ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <form method="post" action="/api/getting-started" className={className}>
      <input type="hidden" name="op" value={op} />
      {item ? <input type="hidden" name="item" value={item} /> : null}
      <input type="hidden" name="next" value={returnTo} />
      <button
        type="submit"
        className="text-white/40 text-xs underline-offset-2 transition-colors hover:text-white hover:underline"
      >
        {children}
      </button>
    </form>
  );
}

/**
 * The checklist card. `returnTo` is where the tick/dismiss forms bounce back
 * to (re-validated server-side); `dismissable` adds the quiet dismiss row.
 */
export function GettingStarted({
  state,
  returnTo,
  dismissable = false,
  className,
}: {
  state: GettingStartedState;
  returnTo: string;
  dismissable?: boolean;
  className?: string;
}): JSX.Element {
  return (
    <Card className={className}>
      <div className="flex items-baseline justify-between gap-3">
        <p className="eyebrow">Getting started</p>
        <span className="text-accent text-sm">
          {state.done}/{state.total}
        </span>
      </div>
      <ul className="mt-4 flex flex-col">
        {state.items.map((item) => {
          const labelClasses = cn(
            "text-base leading-6 transition-colors",
            item.done ? "text-white/45" : "text-white/80 hover:text-white",
          );
          return (
            <li
              key={item.id}
              className="flex items-start gap-3 border-white/[0.06] border-t py-3 first:border-t-0 first:pt-0 last:pb-0"
            >
              {item.done ? (
                <Check
                  aria-hidden="true"
                  className="mt-1 size-4 shrink-0 text-accent"
                  strokeWidth={2}
                />
              ) : (
                <span
                  aria-hidden="true"
                  className="mt-1 size-4 shrink-0 rounded border border-white/25"
                />
              )}
              {item.external ? (
                <a
                  href={item.href}
                  target="_blank"
                  rel="noreferrer"
                  className={labelClasses}
                >
                  {item.label}
                </a>
              ) : (
                <Link href={item.href} className={labelClasses}>
                  {item.label}
                </Link>
              )}
              {item.manual && !item.done ? (
                <TickForm
                  op="toggle"
                  item={item.id}
                  returnTo={returnTo}
                  className="ml-auto shrink-0 self-center"
                >
                  Mark done
                </TickForm>
              ) : null}
            </li>
          );
        })}
      </ul>
      {dismissable ? (
        <div className="mt-3 flex justify-end border-white/[0.06] border-t pt-3">
          <TickForm op="dismiss" returnTo={returnTo}>
            Dismiss checklist
          </TickForm>
        </div>
      ) : null}
    </Card>
  );
}
