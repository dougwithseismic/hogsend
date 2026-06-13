import { ArrowUpRight } from "lucide-react";
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

type RelatedRecipe = Pick<RecipeLander, "slug" | "title" | "cardDescription">;

export function RelatedRecipes({
  recipes,
}: {
  recipes: RelatedRecipe[];
}): JSX.Element {
  return (
    <Section>
      <SectionHeading
        eyebrow="More recipes"
        title="Same engine, different outcome"
      />
      <div className="mt-12 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {recipes.map((recipe, index) => (
          <Reveal key={recipe.slug} delay={(index % 3) * 0.08}>
            <Link
              href={`/recipes/${recipe.slug}`}
              className="group block h-full"
            >
              <Card className="flex h-full flex-col gap-3">
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
        ))}
      </div>
    </Section>
  );
}
