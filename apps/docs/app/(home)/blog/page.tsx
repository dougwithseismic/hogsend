import type { Metadata } from "next";
import type { JSX } from "react";
import { NewsletterCard } from "@/components/blog/newsletter-card";
import { FeaturedPostCard, PostCard } from "@/components/blog/post-card";
import { TagNav } from "@/components/blog/tag-nav";
import { Eyebrow } from "@/components/ds/badge";
import { Section } from "@/components/ds/section";
import { getAllPosts, getFeaturedPost, getLiveTags } from "@/lib/blog";

export const metadata: Metadata = {
  title: "Blog",
  description:
    "Growth, technical marketing, and go-to-market for teams that code — field notes from client work by Doug Silkstone and guests.",
  alternates: { canonical: "/blog" },
};

export default function BlogPage(): JSX.Element {
  const posts = getAllPosts();
  const featured = getFeaturedPost(posts);
  const feed = posts.filter((p) => p !== featured);

  return (
    <main className="flex flex-1 flex-col">
      <Section divider={false} containerClassName="pt-32 pb-16">
        <Eyebrow className="mb-4">Blog</Eyebrow>
        <h1 className="max-w-3xl font-display text-[40px] text-white leading-[1.1] tracking-[-0.02em] md:text-[56px]">
          Growth, for teams that code
        </h1>
        <p className="mt-5 max-w-2xl text-base text-white/60 leading-6">
          Technical marketing, lifecycle, and go-to-market — written from client
          work by Doug Silkstone and guests.
        </p>
        <div className="mt-10">
          <TagNav tags={getLiveTags(posts)} />
        </div>
      </Section>

      {featured ? (
        <Section containerClassName="py-14">
          <FeaturedPostCard post={featured} />
        </Section>
      ) : null}

      <Section containerClassName="py-14">
        <p className="eyebrow mb-2 text-white/50">Latest</p>
        <div className="flex flex-col">
          {feed.map((post) => (
            <PostCard key={post.url} post={post} />
          ))}
          {feed.length === 0 ? (
            <p className="border-white/[0.08] border-t py-8 text-white/50">
              More posts are on the way.
            </p>
          ) : null}
        </div>
      </Section>

      <Section containerClassName="py-20">
        <NewsletterCard />
      </Section>
    </main>
  );
}
