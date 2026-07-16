import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { JSX } from "react";
import { AuthorChip, AuthorSidebar } from "@/components/articles/author";
import { NewsletterCard } from "@/components/articles/newsletter-card";
import { RelatedPostCard } from "@/components/articles/post-card";
import { PostCover } from "@/components/articles/post-cover";
import { ShareButtons } from "@/components/articles/share-buttons";
import { Section } from "@/components/ds/section";
import { getMDXComponents } from "@/components/mdx";
import {
  articlesSource,
  formatPostDate,
  getAllPosts,
  getReadingMinutes,
  getRelatedPosts,
} from "@/lib/articles";
import { getAuthor } from "@/lib/articles/authors";
import { TAGS, type TagSlug } from "@/lib/articles/tags";
import { SITE_URL } from "@/lib/site";
import "../articles.css";

type Params = { slug: string };

export function generateStaticParams(): Params[] {
  return articlesSource.getPages().map((p) => ({ slug: p.slugs[0] ?? "" }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { slug } = await params;
  const post = articlesSource.getPage([slug]);
  if (!post) return {};
  return {
    title: post.data.title,
    description: post.data.description,
    alternates: { canonical: post.url },
    openGraph: {
      type: "article",
      title: post.data.title,
      description: post.data.description,
      publishedTime: post.data.date,
      authors: [getAuthor(post.data.author).name],
    },
  };
}

export default async function ArticlePage({
  params,
}: {
  params: Promise<Params>;
}): Promise<JSX.Element> {
  const { slug } = await params;
  const post = articlesSource.getPage([slug]);
  if (!post) notFound();

  const author = getAuthor(post.data.author);
  const minutes = await getReadingMinutes(post);
  const related = getRelatedPosts(getAllPosts(), post);
  const MDXBody = post.data.body;
  const canonicalUrl = `${SITE_URL}${post.url}`;

  return (
    <main className="flex flex-1 flex-col">
      <Section divider={false} containerClassName="pt-32 pb-12">
        <Link
          href="/articles"
          className="mb-8 inline-flex items-center gap-1.5 text-sm text-white/50 transition-colors hover:text-white"
        >
          <ArrowLeft className="size-3.5" />
          Articles
        </Link>
        <div className="flex flex-wrap gap-2">
          {post.data.tags.map((t) => (
            <Link
              key={t}
              href={`/articles/tag/${t}`}
              className="rounded-full border border-white/10 px-2.5 py-0.5 font-mono text-[11px] text-white/50 uppercase tracking-[0.06em] transition-colors hover:border-white/25 hover:text-white"
            >
              {TAGS[t as TagSlug]?.label ?? t}
            </Link>
          ))}
        </div>
        <h1 className="mt-5 max-w-4xl font-display text-[34px] text-white leading-[1.12] tracking-[-0.02em] md:text-[48px]">
          {post.data.title}
        </h1>
        {post.data.description ? (
          <p className="mt-5 max-w-2xl text-lg text-white/60 leading-7">
            {post.data.description}
          </p>
        ) : null}
        <div className="mt-8 flex flex-wrap items-center gap-x-4 gap-y-2">
          <AuthorChip
            author={author}
            meta={`${formatPostDate(post.data.date)} · ${minutes} min read`}
          />
        </div>
        <PostCover
          seed={post.url}
          image={post.data.image}
          title={post.data.title}
          priority
          className="mt-10 aspect-[21/9] w-full"
        />
      </Section>

      {/* Plain section (not <Section>): its overflow-hidden would break the
          sidebar's position: sticky. */}
      <section className="relative text-white">
        <div className="container-page py-8 md:py-12">
          <div className="grid gap-12 md:grid-cols-[220px_minmax(0,1fr)] md:gap-16">
            <aside className="hidden md:block">
              <div className="sticky top-32 flex flex-col gap-8">
                <AuthorSidebar author={author} />
                <ShareButtons
                  url={canonicalUrl}
                  slug={slug}
                  title={post.data.title}
                />
              </div>
            </aside>
            <div className="min-w-0">
              <article className="article-prose max-w-[42rem]">
                <MDXBody components={getMDXComponents()} />
              </article>
              {/* Mobile share row — the sidebar is hidden below md. */}
              <ShareButtons
                url={canonicalUrl}
                slug={slug}
                title={post.data.title}
                className="mt-12 md:hidden"
              />
            </div>
          </div>
        </div>
      </section>

      {related.length > 0 ? (
        <Section containerClassName="py-16">
          <p className="eyebrow mb-6 text-white/50">Keep reading</p>
          <div className="grid gap-5 md:grid-cols-3">
            {related.map((p) => (
              <RelatedPostCard key={p.url} post={p} />
            ))}
          </div>
        </Section>
      ) : null}

      <Section containerClassName="py-20">
        <NewsletterCard />
      </Section>
    </main>
  );
}
