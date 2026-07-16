import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { JSX } from "react";
import { ShareButtons } from "@/components/articles/share-buttons";
import { Section } from "@/components/ds/section";
import { ThermalLayer } from "@/components/ds/thermal";
import { getMDXComponents } from "@/components/mdx";
import { LadderCta } from "@/components/playbook/ladder-cta";
import { PlayCard } from "@/components/playbook/play-card";
import { PlayViewTracker } from "@/components/playbook/play-tracking";
import {
  getAllPlays,
  getRelatedPlays,
  playbookSource,
  toPlayIndex,
} from "@/lib/playbook";
import { CATEGORIES, type CategorySlug } from "@/lib/playbook/categories";
import { PERSONAS, type PersonaSlug } from "@/lib/playbook/personas";
import { SITE_URL } from "@/lib/site";
import "../playbook.css";

type Params = { slug: string };

export function generateStaticParams(): Params[] {
  return playbookSource.getPages().map((p) => ({ slug: p.slugs[0] ?? "" }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { slug } = await params;
  const play = playbookSource.getPage([slug]);
  if (!play) return {};
  return {
    title: play.data.title,
    description: play.data.description,
    alternates: { canonical: play.url },
    openGraph: {
      type: "article",
      title: play.data.title,
      description: play.data.description,
      publishedTime: play.data.date,
    },
  };
}

export default async function PlayPage({
  params,
}: {
  params: Promise<Params>;
}): Promise<JSX.Element> {
  const { slug } = await params;
  const play = playbookSource.getPage([slug]);
  if (!play) notFound();

  const category = CATEGORIES[play.data.category as CategorySlug];
  const related = toPlayIndex(getRelatedPlays(getAllPlays(), play));
  const MDXBody = play.data.body;
  const canonicalUrl = `${SITE_URL}${play.url}`;

  return (
    <main className="flex flex-1 flex-col">
      <PlayViewTracker slug={slug} category={play.data.category} />
      <Section divider={false} containerClassName="pt-32 pb-12">
        <ThermalLayer strength={0.05} />
        <Link
          href="/playbook"
          className="mb-8 inline-flex items-center gap-1.5 text-sm text-white/50 transition-colors hover:text-white"
        >
          <ArrowLeft className="size-3.5" />
          Playbook
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={`/playbook?category=${play.data.category}`}
            className="rounded-full border px-2.5 py-0.5 font-mono text-[11px] uppercase tracking-[0.06em] transition-colors hover:text-white"
            style={{ borderColor: category.accent, color: category.accent }}
          >
            {category.label}
          </Link>
          {(play.data.personas as PersonaSlug[]).map((p) => (
            <Link
              key={p}
              href={`/playbook?persona=${p}`}
              className="rounded-full border border-white/10 px-2.5 py-0.5 font-mono text-[11px] text-white/50 uppercase tracking-[0.06em] transition-colors hover:border-white/25 hover:text-white"
            >
              {PERSONAS[p].label}
            </Link>
          ))}
          {play.data.timeToResults ? (
            <span className="text-[12px] text-white/40">
              Results: {play.data.timeToResults}
            </span>
          ) : null}
        </div>
        <h1 className="mt-5 max-w-4xl font-display text-[34px] text-white leading-[1.12] tracking-[-0.02em] md:text-[48px]">
          {play.data.title}
        </h1>
        <p className="mt-5 max-w-2xl text-lg text-white/60 leading-7">
          {play.data.hook}
        </p>
      </Section>

      <section className="relative text-white">
        <div className="container-page py-8 md:py-12">
          <div className="grid gap-12 md:grid-cols-[220px_minmax(0,1fr)] md:gap-16">
            <aside className="hidden md:block">
              <div className="sticky top-32 flex flex-col gap-8">
                <ShareButtons
                  url={canonicalUrl}
                  slug={slug}
                  title={play.data.title}
                  campaignPrefix="playbook"
                />
              </div>
            </aside>
            <div className="min-w-0">
              <article className="play-prose max-w-[42rem]">
                <MDXBody components={getMDXComponents()} />
              </article>
              <ShareButtons
                url={canonicalUrl}
                slug={slug}
                title={play.data.title}
                campaignPrefix="playbook"
                className="mt-12 md:hidden"
              />
            </div>
          </div>
        </div>
      </section>

      <Section containerClassName="py-16">
        <p className="eyebrow mb-6 text-white/50">Run it your way</p>
        <LadderCta slug={slug} />
      </Section>

      {related.length > 0 ? (
        <Section containerClassName="py-16">
          <p className="eyebrow mb-6 text-white/50">More plays</p>
          <div className="grid gap-5 md:grid-cols-3">
            {related.map((p) => (
              <PlayCard key={p.url} play={p} />
            ))}
          </div>
        </Section>
      ) : null}
    </main>
  );
}
