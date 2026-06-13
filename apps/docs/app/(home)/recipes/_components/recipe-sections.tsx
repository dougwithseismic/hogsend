import { ArrowLeft, ArrowRight, ArrowUpRight } from "lucide-react";
import Link from "next/link";
import type { JSX } from "react";
import { Eyebrow } from "@/components/ds/badge";
import { Button } from "@/components/ds/button";
import { Card } from "@/components/ds/card";
import { AuroraBeam } from "@/components/ds/fx";
import { Reveal } from "@/components/ds/reveal";
import { Section, SectionHeading } from "@/components/ds/section";
import type { RecipeLander } from "../_data/types";

/* ------------------------------------------------------------------------ */
/* Hero — like UseCaseHero, but the primary CTA is the docs recipe           */
/* ------------------------------------------------------------------------ */

type RecipeHeroProps = {
  eyebrow: string;
  title: string;
  subhead: string;
  docsHref: string;
};

export function RecipeHero({
  eyebrow,
  title,
  subhead,
  docsHref,
}: RecipeHeroProps): JSX.Element {
  return (
    <Section divider={false} containerClassName="container-page pt-32 pb-20">
      <AuroraBeam />
      <div className="relative z-10 flex flex-col items-center text-center">
        <Reveal className="flex flex-col items-center">
          <Eyebrow>{eyebrow}</Eyebrow>
          <h1 className="mt-6 max-w-4xl font-display font-medium text-[40px] text-white leading-[1.05] tracking-[-0.05em] md:text-[64px] md:leading-[1.0]">
            {title}
          </h1>
          <p className="mt-6 max-w-xl text-base text-white/80 leading-6">
            {subhead}
          </p>
        </Reveal>
        <Reveal delay={0.1} className="mt-12 flex flex-col items-center gap-5">
          <div className="flex flex-wrap items-center justify-center gap-4">
            <Button href={docsHref} icon>
              Read the full recipe
            </Button>
            <Button href="/docs/getting-started" variant="outline">
              Start building
            </Button>
          </div>
          <p className="font-mono text-[11px] text-white/50 uppercase tracking-[0.08em]">
            Free to self-host · One scaffold command · No per-contact billing
          </p>
        </Reveal>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------------ */
/* Related recipes — sibling landers, resolved by the page                   */
/* ------------------------------------------------------------------------ */

type RecipeCardData = Pick<RecipeLander, "slug" | "title" | "cardDescription">;

/** A single recipe card linking to its lander — shared across recipe grids. */
export function RecipeCard({
  recipe,
  index = 0,
}: {
  recipe: RecipeCardData;
  index?: number;
}): JSX.Element {
  return (
    <Reveal delay={(index % 3) * 0.08} className="h-full">
      <Link href={`/recipes/${recipe.slug}`} className="group block h-full">
        <Card className="flex h-full flex-col gap-3 group-hover:border-white/15">
          <h3 className="font-medium font-sans text-white text-xl leading-[1.2] tracking-[-0.02em]">
            {recipe.title}
          </h3>
          <p className="text-base text-white/60 leading-6">
            {recipe.cardDescription}
          </p>
          <span className="mt-auto inline-flex items-center gap-1.5 pt-2 text-sm text-white/60 transition-colors group-hover:text-white">
            Read the recipe
            <ArrowUpRight
              aria-hidden="true"
              className="size-4 transition-transform duration-200 group-hover:translate-x-0.5"
              strokeWidth={1.5}
            />
          </span>
        </Card>
      </Link>
    </Reveal>
  );
}

export function RelatedRecipes({
  recipes,
}: {
  recipes: RecipeCardData[];
}): JSX.Element {
  return (
    <Section>
      <SectionHeading
        eyebrow="More recipes"
        title="Same engine, different outcome"
      />
      <div className="mt-12 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {recipes.map((recipe, index) => (
          <RecipeCard key={recipe.slug} recipe={recipe} index={index} />
        ))}
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------------ */
/* In-category prev/next pager — flip through one category's recipes         */
/* ------------------------------------------------------------------------ */

type PagerEnd = { slug: string; title: string } | undefined;

export function RecipePager({
  categoryTitle,
  categoryHref,
  prev,
  next,
}: {
  categoryTitle: string;
  categoryHref: string;
  prev: PagerEnd;
  next: PagerEnd;
}): JSX.Element {
  return (
    <Section>
      <div className="flex items-center justify-center pb-8">
        <Link
          href={categoryHref}
          className="rounded text-sm text-white/50 uppercase tracking-[0.08em] outline-none transition-colors hover:text-white focus-visible:ring-2 focus-visible:ring-accent"
        >
          All {categoryTitle} recipes
        </Link>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {prev ? (
          <Link
            href={`/recipes/${prev.slug}`}
            className="group flex flex-col gap-1.5 rounded-md border border-white/[0.08] p-5 outline-none transition-colors hover:border-white/15 focus-visible:ring-2 focus-visible:ring-accent"
          >
            <span className="inline-flex items-center gap-1.5 text-sm text-white/50">
              <ArrowLeft
                aria-hidden="true"
                className="size-4 transition-transform duration-200 group-hover:-translate-x-0.5"
                strokeWidth={1.5}
              />
              Previous
            </span>
            <span className="font-medium text-base text-white tracking-[-0.02em]">
              {prev.title}
            </span>
          </Link>
        ) : (
          <span aria-hidden="true" className="hidden sm:block" />
        )}
        {next ? (
          <Link
            href={`/recipes/${next.slug}`}
            className="group flex flex-col items-end gap-1.5 rounded-md border border-white/[0.08] p-5 text-right outline-none transition-colors hover:border-white/15 focus-visible:ring-2 focus-visible:ring-accent sm:col-start-2"
          >
            <span className="inline-flex items-center gap-1.5 text-sm text-white/50">
              Next
              <ArrowRight
                aria-hidden="true"
                className="size-4 transition-transform duration-200 group-hover:translate-x-0.5"
                strokeWidth={1.5}
              />
            </span>
            <span className="font-medium text-base text-white tracking-[-0.02em]">
              {next.title}
            </span>
          </Link>
        ) : null}
      </div>
    </Section>
  );
}
