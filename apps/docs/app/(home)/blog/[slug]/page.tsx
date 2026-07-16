import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { JSX } from "react";
import { AuthorChip, AuthorSidebar } from "@/components/blog/author";
import { NewsletterCard } from "@/components/blog/newsletter-card";
import { RelatedPostCard } from "@/components/blog/post-card";
import { PostCover } from "@/components/blog/post-cover";
import { Section } from "@/components/ds/section";
import { getMDXComponents } from "@/components/mdx";
import {
  blogSource,
  formatPostDate,
  getAllPosts,
  getReadingMinutes,
  getRelatedPosts,
} from "@/lib/blog";
import { getAuthor } from "@/lib/blog/authors";
import { TAGS, type TagSlug } from "@/lib/blog/tags";
import "../blog.css";

type Params = { slug: string };

export function generateStaticParams(): Params[] {
  return blogSource.getPages().map((p) => ({ slug: p.slugs[0] ?? "" }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { slug } = await params;
  const post = blogSource.getPage([slug]);
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

export default async function BlogPostPage({
  params,
}: {
  params: Promise<Params>;
}): Promise<JSX.Element> {
  const { slug } = await params;
  const post = blogSource.getPage([slug]);
  if (!post) notFound();

  const author = getAuthor(post.data.author);
  const minutes = await getReadingMinutes(post);
  const related = getRelatedPosts(getAllPosts(), post);
  const MDXBody = post.data.body;

  return (
    <main className="flex flex-1 flex-col">
      <Section divider={false} containerClassName="pt-32 pb-12">
        <Link
          href="/blog"
          className="mb-8 inline-flex items-center gap-1.5 text-sm text-white/50 transition-colors hover:text-white"
        >
          <ArrowLeft className="size-3.5" />
          Blog
        </Link>
        <div className="flex flex-wrap gap-2">
          {post.data.tags.map((t) => (
            <Link
              key={t}
              href={`/blog/tag/${t}`}
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

      <Section divider={false} containerClassName="py-8 md:py-12">
        <div className="grid gap-12 md:grid-cols-[220px_minmax(0,1fr)] md:gap-16">
          <aside className="hidden md:block">
            <div className="sticky top-32">
              <AuthorSidebar author={author} />
            </div>
          </aside>
          <article className="blog-prose max-w-[42rem]">
            <MDXBody components={getMDXComponents()} />
          </article>
        </div>
      </Section>

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
