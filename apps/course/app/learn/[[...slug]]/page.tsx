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
import { getMDXComponents } from "@/components/mdx";
import {
  ensureEnrollment,
  freeLessonParams,
  getSession,
  isFreeLesson,
} from "@/lib/gating";
import { source } from "@/lib/source";

// Gated lessons render on demand (only first-lesson params are prerendered).
export const dynamicParams = true;

export default async function Page(props: {
  params: Promise<{ slug?: string[] }>;
}) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const slugs = params.slug ?? [];

  // The session is read ONLY on the gated branch, so public first lessons stay
  // statically generated and indexable. The page RSC is the security boundary.
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

export function generateStaticParams() {
  // Only the public first lesson of each course is prerendered; everything else
  // is dynamic and never baked into a static .html/.rsc file.
  return freeLessonParams();
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
