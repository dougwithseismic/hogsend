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
import { getMDXComponents } from "@/components/mdx";
import { hasPurchased, isCoursePaywalled } from "@/lib/entitlements";
import { ensureEnrollment, getSession, isFreeLesson } from "@/lib/gating";
import { source } from "@/lib/source";

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

  // The session is read ONLY on the gated branch; public first lessons skip it
  // and SSR their full body to anon (indexable). The page RSC is the security
  // boundary — an anon gated request returns <LessonGate> before the body is read.
  if (!isFreeLesson(slugs)) {
    const session = await getSession();
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
      !(await hasPurchased(session.user.id, slugs[0]))
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
    await ensureEnrollment(
      {
        id: session.user.id,
        email: session.user.email,
        name: session.user.name,
      },
      slugs[0],
    );
  }

  const MDX = page.data.body;
  const lessonSlug = slugs[slugs.length - 1] ?? "";

  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <DocsBody>
        <MDX
          components={getMDXComponents({
            a: createRelativeLink(source, page),
          })}
        />
        {slugs.length >= 2 ? (
          <LessonFooter course={slugs[0]} lesson={lessonSlug} />
        ) : null}
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
