import { and, eq } from "drizzle-orm";
import { Check } from "lucide-react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Eyebrow, TagPill } from "@/components/ds/badge";
import { Button } from "@/components/ds/button";
import { ProcessSteps } from "@/components/ds/process";
import {
  GettingStarted,
  loadGettingStarted,
} from "@/components/getting-started";
import { getCourseModules } from "@/lib/course-ui";
import { COURSES, getCourse } from "@/lib/courses";
import { db } from "@/lib/db";
import { lessonProgress } from "@/lib/db/schema";
import { hasAccess } from "@/lib/entitlements";
import { FLAGSHIP_CONTENT_FACTS } from "@/lib/flagship-facts";
import { ensureEnrollment, getSession } from "@/lib/gating";
import { safeNext } from "@/lib/safe-next";
import { DISCORD_INVITE_URL } from "@/lib/site";

// Reads the session + the user's DB rows — always per-request.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Welcome",
  robots: { index: false, follow: false },
};

/**
 * Post-purchase landing: checkout's success_url points here. Walks the whole
 * product once (chapters → workbook → quizzes → plan → community), shows the
 * getting-started checklist, and hands the reader on to their next lesson.
 * Deliberately does NOT hard-gate on ownership — the browser can arrive
 * before the Stripe webhook writes the purchase row, so the tour renders for
 * any signed-in reader and the owned state appears once it exists.
 */
export default async function WelcomePage(props: {
  searchParams: Promise<{ course?: string; next?: string; paid?: string }>;
}) {
  const sp = await props.searchParams;

  // Bounce a signed-out reader to sign-in, preserving the checkout params so
  // they land back here (with ?course/?next/?paid) after authenticating —
  // safeNext on the sign-in side accepts this /welcome?… shape.
  const session = await getSession();
  if (!session) {
    const qs = new URLSearchParams();
    if (sp.course) qs.set("course", sp.course);
    if (sp.next) qs.set("next", sp.next);
    if (sp.paid) qs.set("paid", sp.paid);
    redirect(
      `/sign-in?next=${encodeURIComponent(
        qs.size ? `/welcome?${qs}` : "/welcome",
      )}`,
    );
  }
  const user = session.user;

  // ?course is presentational (which title to welcome them to); anything
  // unknown — including the all-access SKU — falls back to the flagship.
  const requested = getCourse(sp.course ?? "");
  const course =
    requested && !requested.comingSoon
      ? requested
      : COURSES.find((c) => !c.comingSoon);
  if (!course) redirect("/");
  const nextParam = safeNext(sp.next);

  const owned = await hasAccess(user.id, course.slug);
  // Purchase ≠ enrollment (that normally happens on first gated-lesson
  // visit) — enroll here so /account and /workbook aren't empty for buyers
  // who came straight from checkout.
  if (owned) {
    await ensureEnrollment(
      { id: user.id, email: user.email, name: user.name },
      course.slug,
    );
  }

  const [gettingStarted, completedRows] = await Promise.all([
    loadGettingStarted(user.id),
    db
      .select({ lessonSlug: lessonProgress.lessonSlug })
      .from(lessonProgress)
      .where(
        and(
          eq(lessonProgress.userId, user.id),
          eq(lessonProgress.courseSlug, course.slug),
        ),
      ),
  ]);

  const lessons = getCourseModules(course.slug).flatMap((m) => m.lessons);
  const completed = new Set(completedRows.map((r) => r.lessonSlug));
  const nextLesson = lessons.find((l) => !completed.has(l.slug)) ?? lessons[0];
  const started = completed.size > 0;
  // Honor a lesson `next` from checkout for a fresh reader; once they've read
  // anything, the real next unread lesson wins (an all-access purchase from
  // /pricing passes next=/account, which is not where "Start chapter 0" goes).
  const continueHref =
    (!started && nextParam?.startsWith("/learn/") ? nextParam : null) ??
    nextLesson?.url ??
    `/${course.slug}`;

  // Return URL for the checklist tick/dismiss forms — carries course+next but
  // NOT paid, so a non-buyer ticking an item doesn't 303 back into the
  // "unlocking your purchase" hint.
  const selfUrl = `/welcome?course=${encodeURIComponent(course.slug)}${
    nextParam ? `&next=${encodeURIComponent(nextParam)}` : ""
  }`;
  // The "refresh while the webhook catches up" link keeps paid so a real buyer
  // who isn't owned yet still sees the hint after refreshing.
  const refreshUrl = sp.paid ? `${selfUrl}&paid=1` : selfUrl;

  const steps = [
    {
      n: "01",
      title: "Read chapter 0",
      description:
        "About 20 minutes, and free for everyone. It sets the order the whole course runs in: measure, then keep, then grow.",
    },
    {
      n: "02",
      title: "Work the workbook",
      description: `${FLAGSHIP_CONTENT_FACTS.workbookItems} interactive items save to your account as you read — ${FLAGSHIP_CONTENT_FACTS.checkIns} profiling check-ins, ${FLAGSHIP_CONTENT_FACTS.writingPrompts} writing prompts, ${FLAGSHIP_CONTENT_FACTS.calculators} calculators, and every checklist. All of it lands on one page, editable in place.`,
    },
    {
      n: "03",
      title: "Test yourself",
      description: `${FLAGSHIP_CONTENT_FACTS.quizzes} quizzes drawing on a pool of ${FLAGSHIP_CONTENT_FACTS.quizQuestions} authored questions — each run samples 5 — plus ${FLAGSHIP_CONTENT_FACTS.flashcards} flashcards across ${FLAGSHIP_CONTENT_FACTS.flashcardDecks} decks.`,
    },
    {
      n: "04",
      title: "Build your plan",
      description: `Chapter 10 assembles a ${FLAGSHIP_CONTENT_FACTS.dayPlan}-day plan — 48 checklist items you tick off from your workbook over the months that follow.`,
    },
    {
      n: "05",
      title: "Join the community, watch the bell",
      description:
        "The bell in the nav is your feed — course emails land there too. Readers also share a Discord; the invite is below.",
      media: (
        <a
          href={DISCORD_INVITE_URL}
          target="_blank"
          rel="noreferrer"
          className="text-sm text-white/60 underline underline-offset-2 transition-colors hover:text-white"
        >
          Join the Discord →
        </a>
      ),
    },
  ];

  return (
    <main className="container-page py-16 md:py-24">
      <div className="mx-auto flex max-w-2xl flex-col">
        <header className="flex flex-col items-center text-center">
          <Eyebrow>You're in</Eyebrow>
          <h1 className="mt-4 font-display text-[40px] leading-[1.1] tracking-[-0.045em] md:text-[56px]">
            Welcome to {course.title}
          </h1>
          <p className="mt-5 max-w-xl text-base text-white/60 leading-6">
            Fifteen chapters in five modules, about 6 hours end to end — and
            here is everything that comes with them.
          </p>
          {owned ? (
            <TagPill accent className="mt-6">
              <Check className="mr-1 size-3" strokeWidth={2.5} aria-hidden />{" "}
              Owned — lifetime access
            </TagPill>
          ) : sp.paid ? (
            // Arrived from a completed checkout (?paid is set only on its
            // success URL) but the purchase row isn't visible yet — the webhook
            // can land after the redirect. No polling; a refresh suffices.
            <p className="mt-6 text-sm text-white/50">
              Unlocking your purchase — this takes a few seconds.{" "}
              <a href={refreshUrl} className="text-accent hover:underline">
                Refresh
              </a>
            </p>
          ) : null}
        </header>

        <ProcessSteps steps={steps} className="mt-14" />

        <GettingStarted
          state={gettingStarted}
          returnTo={selfUrl}
          className="mt-8"
        />

        <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
          <Button href={continueHref} variant="accent" icon>
            {started ? "Pick up where you left off" : "Start chapter 0"}
          </Button>
          <Button href="/workbook" variant="outline" icon>
            Open your workbook
          </Button>
        </div>

        <p className="mt-8 text-center text-sm text-white/40 leading-6">
          A few short emails follow as you make progress: a workbook tour after
          your first chapter, practice and community mid-course, and your plan
          check-ins after you finish.
        </p>
      </div>
    </main>
  );
}
