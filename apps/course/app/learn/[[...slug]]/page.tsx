import { and, eq, inArray } from "drizzle-orm";
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
} from "fumadocs-ui/layouts/docs/page";
import { createRelativeLink } from "fumadocs-ui/mdx";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LessonFooter } from "@/components/auth/lesson-footer";
import { LessonGate } from "@/components/auth/lesson-gate";
import { Paywall } from "@/components/auth/paywall";
import {
  ChapterRecap,
  ChapterWorkbook,
} from "@/components/course/chapter-workbook";
import { LessonProvider } from "@/components/course/lesson-context";
import { LlmActions } from "@/components/course/llm-actions";
import { WorkbookStateProvider } from "@/components/course/workbook-state";
import { getMDXComponents } from "@/components/mdx";
import { db } from "@/lib/db";
import { lessonProgress, response } from "@/lib/db/schema";
import { hasAccess, isCoursePaywalled } from "@/lib/entitlements";
import { ensureEnrollment, getSession, isFreeLesson } from "@/lib/gating";
import lessonTextJson from "@/lib/lesson-text.generated.json";
import { ARTICLE_PROMPT } from "@/lib/llm-brand";
import { source } from "@/lib/source";
import { lessonWorkbookItems, type SavedValue } from "@/lib/workbook";

const LESSON_TEXT = lessonTextJson as Record<
  string,
  { title: string; text: string }
>;

/** The following lesson in course order (numeric slug prefixes sort), or null.
 *  `lesson` is the full sub-path after the course (`slugs.slice(1).join("/")`),
 *  so this walks atoms within a chapter and then across chapters. */
function nextLessonOf(
  course: string,
  lesson: string,
): { url: string; title: string } | null {
  const pages = source
    .getPages()
    .filter((p) => p.slugs.length >= 2 && p.slugs[0] === course)
    .sort((a, b) => a.slugs.join("/").localeCompare(b.slugs.join("/")));
  const idx = pages.findIndex((p) => p.slugs.slice(1).join("/") === lesson);
  const nextPage = idx >= 0 ? pages[idx + 1] : undefined;
  return nextPage ? { url: nextPage.url, title: nextPage.data.title } : null;
}

// The gated branch reads headers() (session), which is illegal during a static-
// generation pass. With generateStaticParams + dynamicParams, gated params were
// generated through the on-demand STATIC/ISR pipeline and threw DYNAMIC_SERVER_USAGE
// (that path would also cache a gated render cross-user). Force per-request dynamic
// SSR for the whole segment: headers() is always legal and nothing is cached to disk.
export const dynamic = "force-dynamic";

export default async function Page(props: {
  params: Promise<{ slug?: string[] }>;
}) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const slugs = params.slug ?? [];

  // The session is read for every lesson request (the segment is force-dynamic
  // SSR either way): gated lessons gate on it, and signed-in readers get their
  // saved workbook answers server-fed into the interactive blocks. The page RSC
  // stays the security boundary — an anon gated request returns <LessonGate>
  // before the body is read.
  const session = slugs.length >= 2 ? await getSession() : null;
  const free = isFreeLesson(slugs);

  if (!free) {
    if (!session) {
      return (
        <LessonGate
          title={page.data.title}
          description={page.data.description}
          lessonUrl={page.url}
        />
      );
    }
    // Signed in but, for a paywalled course, not yet purchased → the buy wall.
    // Returned before the MDX body is read, so the body never leaks. Entitlement
    // is derived from the session user id + DB, never from a query param.
    if (
      isCoursePaywalled(slugs[0]) &&
      !(await hasAccess(session.user.id, slugs[0]))
    ) {
      return (
        <Paywall
          course={slugs[0]}
          lessonUrl={page.url}
          title={page.data.title}
          description={page.data.description}
        />
      );
    }
  }

  const MDX = page.data.body;
  // Lesson identity = the full path after the course, so a nested atom is
  // `01-what-is-posthog/why-measure` (not just `why-measure`). This keys the
  // workbook manifest, the quiz response, and lessonProgress, and matches the
  // `slugs.join("/")` completion key the sidebar decoration uses. Flat lessons
  // are unchanged (`01-what-is-posthog`), so existing progress data is stable.
  const lessonSlug = slugs.slice(1).join("/");
  const articleText = LESSON_TEXT[`${slugs[0]}/${lessonSlug}`]?.text;

  const body = (
    <MDX
      components={getMDXComponents({
        a: createRelativeLink(source, page),
      })}
    />
  );

  // The signed-in reader's saved answers for THIS lesson's blocks (the manifest
  // lists every key the page can render, including cross-lesson reuse like the
  // chapter-2 prompt chapter 10 re-renders), fed to the client store so blocks
  // render filled in the SSR HTML. Fetched alongside the idempotent enrollment
  // upsert — the two are independent DB round-trips.
  let initialResponses: Record<string, SavedValue> = {};
  let lessonCompleted = false;
  if (session && slugs.length >= 2) {
    const user = {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
    };
    const keys = lessonWorkbookItems(slugs[0], lessonSlug).map((i) => i.key);
    const [rows, progressRows] = await Promise.all([
      keys.length > 0
        ? db
            .select({ key: response.key, value: response.value })
            .from(response)
            .where(
              and(eq(response.userId, user.id), inArray(response.key, keys)),
            )
        : Promise.resolve([]),
      db
        .select({ id: lessonProgress.id })
        .from(lessonProgress)
        .where(
          and(
            eq(lessonProgress.userId, user.id),
            eq(lessonProgress.courseSlug, slugs[0]),
            eq(lessonProgress.lessonSlug, lessonSlug),
          ),
        )
        .limit(1),
      free ? Promise.resolve() : ensureEnrollment(user, slugs[0]),
    ]);
    initialResponses = Object.fromEntries(
      rows.map((row) => [row.key, row.value as SavedValue]),
    );
    lessonCompleted = progressRows.length > 0;
  }

  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <DocsBody>
        {slugs.length >= 2 ? (
          // Interactive blocks (Quiz/CheckIn/Checklist) read their lesson here.
          // Keyed by lesson: App Router soft navigation keeps same-position
          // client components MOUNTED across param changes, so without the key
          // the store/footer would hold the previous lesson's state.
          <LessonProvider
            key={`${slugs[0]}/${lessonSlug}`}
            course={slugs[0]}
            lesson={lessonSlug}
          >
            <WorkbookStateProvider initial={initialResponses}>
              {articleText ? (
                <div className="not-prose mb-8 flex justify-end">
                  <LlmActions
                    text={articleText}
                    prompt={ARTICLE_PROMPT}
                    copyLabel="Copy for LLM"
                  />
                </div>
              ) : null}
              <ChapterWorkbook signedIn={session !== null} />
              {body}
              <ChapterRecap signedIn={session !== null} />
              <LessonFooter
                course={slugs[0]}
                lesson={lessonSlug}
                completed={lessonCompleted}
                next={nextLessonOf(slugs[0], lessonSlug)}
              />
            </WorkbookStateProvider>
          </LessonProvider>
        ) : (
          body
        )}
      </DocsBody>
    </DocsPage>
  );
}

export async function generateMetadata(props: {
  params: Promise<{ slug?: string[] }>;
}): Promise<Metadata> {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const free = isFreeLesson(params.slug ?? []);
  return {
    title: page.data.title,
    description: page.data.description,
    // Gated lessons render a thin wall to anonymous crawlers — keep them out of
    // the index; public first lessons stay indexable.
    ...(free ? {} : { robots: { index: false, follow: false } }),
  };
}
