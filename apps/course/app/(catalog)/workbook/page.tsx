import { desc, eq } from "drizzle-orm";
import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getCourse } from "@/lib/courses";
import { db } from "@/lib/db";
import { response } from "@/lib/db/schema";
import { source } from "@/lib/source";

// Reads the session + the user's DB rows — always per-request.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Your workbook",
  robots: { index: false, follow: false },
};

/**
 * Everything the reader has written or answered across the course, in one
 * reviewable place: workbook notes, check-in answers, plan checklists, quiz
 * scores. Grouped by lesson in course order, each group linking back to the
 * lesson it came from — the profile they build in the lessons, readable back.
 */

type Row = typeof response.$inferSelect;

type LessonGroup = {
  course: string;
  lesson: string | null;
  title: string;
  href: string | null;
  rows: Row[];
};

/** Course-order position for sorting groups (lessons sort lexically). */
function lessonOrderKey(g: LessonGroup): string {
  return `${g.course}/${g.lesson ?? "~"}`; // "~" sorts unplaced rows last
}

function groupByLesson(rows: Row[]): LessonGroup[] {
  const groups = new Map<string, LessonGroup>();
  for (const row of rows) {
    const course = row.courseSlug ?? "";
    const lesson = row.lessonSlug ?? null;
    const mapKey = `${course}/${lesson ?? ""}`;
    let group = groups.get(mapKey);
    if (!group) {
      const page =
        course && lesson ? source.getPage([course, lesson]) : undefined;
      group = {
        course,
        lesson,
        title: page?.data.title ?? getCourse(course)?.title ?? "General notes",
        href: page ? page.url : null,
        rows: [],
      };
      groups.set(mapKey, group);
    }
    group.rows.push(row);
  }
  return [...groups.values()].sort((a, b) =>
    lessonOrderKey(a).localeCompare(lessonOrderKey(b)),
  );
}

const KIND_LABEL: Record<string, string> = {
  note: "Workbook",
  profile: "Check-in",
  checklist: "Checklist",
  quiz: "Quiz",
};

/** Render order within a lesson group: written work first, score last. */
const KIND_ORDER = ["note", "profile", "checklist", "quiz"];

function Entry({ row }: { row: Row }) {
  const v = (row.value ?? {}) as {
    text?: string;
    prompt?: string;
    question?: string;
    choices?: string[];
    note?: string;
    checked?: string[];
    title?: string;
    score?: number;
    total?: number;
  };

  return (
    <div className="rounded-md border border-white/[0.08] bg-white/[0.015] p-4">
      <p className="font-medium text-[10px] text-accent uppercase tracking-[0.14em]">
        {KIND_LABEL[row.kind] ?? row.kind}
      </p>

      {row.kind === "note" ? (
        <>
          {v.prompt ? (
            <p className="mt-1.5 font-medium text-sm text-white">{v.prompt}</p>
          ) : null}
          <p className="mt-2 whitespace-pre-wrap text-sm text-white/75 leading-relaxed">
            {v.text}
          </p>
        </>
      ) : null}

      {row.kind === "profile" ? (
        <>
          {v.question ? (
            <p className="mt-1.5 font-medium text-sm text-white">
              {v.question}
            </p>
          ) : null}
          {v.choices && v.choices.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {v.choices.map((c) => (
                <span
                  key={c}
                  className="rounded-full border border-accent/40 bg-accent-tint px-2.5 py-1 text-white/90 text-xs"
                >
                  {c}
                </span>
              ))}
            </div>
          ) : null}
          {v.note ? (
            <p className="mt-2 whitespace-pre-wrap text-sm text-white/60 leading-relaxed">
              {v.note}
            </p>
          ) : null}
        </>
      ) : null}

      {row.kind === "checklist" ? (
        <>
          <p className="mt-1.5 font-medium text-sm text-white">
            {v.title ?? "Checklist"}
            <span className="ml-2 font-normal text-white/50">
              {v.checked?.length ?? 0} done
            </span>
          </p>
          <ul className="mt-2 flex flex-col gap-1">
            {(v.checked ?? []).map((item) => (
              <li key={item} className="flex gap-2 text-sm text-white/60">
                <span className="text-good">✓</span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {row.kind === "quiz" ? (
        <p className="mt-1.5 text-sm text-white">
          Score:{" "}
          <span className="font-medium">
            {v.score}/{v.total}
          </span>
        </p>
      ) : null}
    </div>
  );
}

export default async function WorkbookPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in?next=/workbook");

  const rows = await db
    .select()
    .from(response)
    .where(eq(response.userId, session.user.id))
    .orderBy(desc(response.updatedAt));

  const groups = groupByLesson(rows);

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-16">
      <h1 className="font-display text-3xl tracking-[-0.02em]">
        Your workbook
      </h1>
      <p className="mt-2 text-sm text-white/55 leading-6">
        Everything you've written and answered across the course — your
        commitments, drafts, check-ins, and scores — each linked back to the
        lesson it belongs to.
      </p>

      {groups.length === 0 ? (
        <div className="mt-10 rounded-md border border-white/[0.08] bg-white/[0.015] p-8 text-center">
          <p className="text-sm text-white/60">
            Nothing here yet. Answers, notes, and checklists you save inside
            lessons land here automatically.
          </p>
          <Link
            href="/"
            className="mt-4 inline-block rounded-[10px] border border-white/[0.12] bg-white/[0.03] px-4 py-2 font-medium text-sm text-white transition-colors hover:border-white/30"
          >
            Browse courses
          </Link>
        </div>
      ) : (
        <div className="mt-10 flex flex-col gap-10">
          {groups.map((group) => (
            <section key={`${group.course}/${group.lesson ?? ""}`}>
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="font-medium text-lg text-white tracking-[-0.01em]">
                  {group.title}
                </h2>
                {group.href ? (
                  <Link
                    href={group.href}
                    className="whitespace-nowrap text-sm text-white/50 underline transition-colors hover:text-white"
                  >
                    Revisit lesson →
                  </Link>
                ) : null}
              </div>
              <div className="mt-4 flex flex-col gap-3">
                {[...group.rows]
                  .sort(
                    (a, b) =>
                      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind),
                  )
                  .map((row) => (
                    <Entry key={row.id} row={row} />
                  ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
