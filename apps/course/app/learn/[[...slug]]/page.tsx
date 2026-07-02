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
import { WorkbookStateProvider } from "@/components/course/workbook-state";
import { getMDXComponents } from "@/components/mdx";
import { db } from "@/lib/db";
import { response } from "@/lib/db/schema";
import { hasAccess, isCoursePaywalled } from "@/lib/entitlements";
import { ensureEnrollment, getSession, isFreeLesson } from "@/lib/gating";
import { source } from "@/lib/source";
import { lessonWorkbookItems, type SavedValue } from "@/lib/workbook";

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
  const lessonSlug = slugs[slugs.length - 1] ?? "";

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
  if (session && slugs.length >= 2) {
    const user = {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
    };
    const keys = lessonWorkbookItems(slugs[0], lessonSlug).map((i) => i.key);
    const [rows] = await Promise.all([
      keys.length > 0
        ? db
            .select({ key: response.key, value: response.value })
            .from(response)
            .where(
              and(eq(response.userId, user.id), inArray(response.key, keys)),
            )
        : Promise.resolve([]),
      free ? Promise.resolve() : ensureEnrollment(user, slugs[0]),
    ]);
    initialResponses = Object.fromEntries(
      rows.map((row) => [row.key, row.value as SavedValue]),
    );
  }

  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <DocsBody>
        {slugs.length >= 2 ? (
          // Interactive blocks (Quiz/CheckIn/Checklist) read their lesson here.
          <LessonProvider course={slugs[0]} lesson={lessonSlug}>
            <WorkbookStateProvider initial={initialResponses}>
              <ChapterWorkbook signedIn={session !== null} />
              {body}
              <ChapterRecap signedIn={session !== null} />
              <LessonFooter course={slugs[0]} lesson={lessonSlug} />
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
