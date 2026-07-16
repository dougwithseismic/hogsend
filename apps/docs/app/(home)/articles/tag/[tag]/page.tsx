import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { JSX } from "react";
import { NewsletterCard } from "@/components/articles/newsletter-card";
import { PostCard } from "@/components/articles/post-card";
import { TagNav } from "@/components/articles/tag-nav";
import { Eyebrow } from "@/components/ds/badge";
import { Section } from "@/components/ds/section";
import { getAllPosts, getLiveTags, getPostsByTag } from "@/lib/articles";
import { isTagSlug, TAGS } from "@/lib/articles/tags";

type Params = { tag: string };

export function generateStaticParams(): Params[] {
  return getLiveTags(getAllPosts()).map((t) => ({ tag: t.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { tag } = await params;
  if (!isTagSlug(tag)) return {};
  return {
    title: `${TAGS[tag].label} — Articles`,
    description: `Posts on ${TAGS[tag].label.toLowerCase()} from Hogsend articles.`,
    alternates: { canonical: `/articles/tag/${tag}` },
  };
}

export default async function ArticlesTagPage({
  params,
}: {
  params: Promise<Params>;
}): Promise<JSX.Element> {
  const { tag } = await params;
  if (!isTagSlug(tag)) notFound();

  const posts = getAllPosts();
  const tagged = getPostsByTag(posts, tag);
  if (tagged.length === 0) notFound();

  return (
    <main className="flex flex-1 flex-col">
      <Section divider={false} containerClassName="pt-32 pb-16">
        <Eyebrow className="mb-4">Articles</Eyebrow>
        <h1 className="max-w-3xl font-display text-[40px] text-white leading-[1.1] tracking-[-0.02em] md:text-[56px]">
          {TAGS[tag].label}
        </h1>
        <div className="mt-10">
          <TagNav tags={getLiveTags(posts)} active={tag} />
        </div>
      </Section>

      <Section containerClassName="py-14">
        <div className="flex flex-col">
          {tagged.map((post) => (
            <PostCard key={post.url} post={post} />
          ))}
        </div>
      </Section>

      <Section containerClassName="py-20">
        <NewsletterCard />
      </Section>
    </main>
  );
}
