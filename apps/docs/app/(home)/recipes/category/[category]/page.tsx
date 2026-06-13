import { ArrowUpRight } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { JSX } from "react";
import { Eyebrow } from "@/components/ds/badge";
import { Button } from "@/components/ds/button";
import { Card } from "@/components/ds/card";
import { CodeWindow } from "@/components/ds/code-window";
import { AuroraBeam } from "@/components/ds/fx";
import { Reveal } from "@/components/ds/reveal";
import { Section, SectionHeading } from "@/components/ds/section";
import { ClosingCta } from "../../../use-cases/_components/use-case-sections";
import { getRecipesByCategory } from "../../_data";
import { RECIPE_CATEGORIES, type RecipeCategoryId } from "../../_data/types";

const CATEGORY_IDS = Object.keys(RECIPE_CATEGORIES) as RecipeCategoryId[];

function isCategoryId(value: string): value is RecipeCategoryId {
  return (CATEGORY_IDS as string[]).includes(value);
}

export function generateStaticParams(): Array<{ category: string }> {
  return CATEGORY_IDS.map((category) => ({ category }));
}

export async function generateMetadata(props: {
  params: Promise<{ category: string }>;
}): Promise<Metadata> {
  const { category } = await props.params;
  if (!isCategoryId(category)) notFound();
  const meta = RECIPE_CATEGORIES[category];
  const count = getRecipesByCategory(category).length;

  return {
    title: `${meta.title} recipes`,
    description: `${count} ${meta.title.toLowerCase()} recipes for Hogsend, each with the code to copy. ${meta.description}`,
  };
}

export default async function RecipeCategoryPage(props: {
  params: Promise<{ category: string }>;
}): Promise<JSX.Element> {
  const { category } = await props.params;
  if (!isCategoryId(category)) notFound();

  const meta = RECIPE_CATEGORIES[category];
  const recipes = getRecipesByCategory(category);
  const others = CATEGORY_IDS.filter((id) => id !== category);

  return (
    <main className="flex flex-1 flex-col">
      {/* Hero */}
      <Section divider={false} containerClassName="container-page pt-32 pb-16">
        <AuroraBeam />
        <div className="relative z-10 flex flex-col items-center text-center">
          <Reveal className="flex flex-col items-center">
            <Eyebrow>{`Recipes — ${meta.title}`}</Eyebrow>
            <h1 className="mt-6 max-w-3xl font-display font-medium text-[40px] text-white leading-[1.05] tracking-[-0.05em] md:text-[56px] md:leading-[1.0]">
              {meta.title}
            </h1>
            <p className="mt-6 max-w-xl text-base text-white/80 leading-6">
              {meta.description} Each one below is the working code — copy it
              into your app.
            </p>
          </Reveal>
          <Reveal delay={0.1} className="mt-8">
            <Link
              href="/recipes"
              className="rounded text-sm text-white/60 outline-none transition-colors hover:text-white focus-visible:ring-2 focus-visible:ring-accent"
            >
              ← All recipe categories
            </Link>
          </Reveal>
        </div>
      </Section>

      {/* The cookbook — every recipe in the category, with its code inline */}
      <Section>
        <div className="flex flex-col gap-20">
          {recipes.map((recipe) => {
            const primary = recipe.code[0];
            return (
              <Reveal key={recipe.slug}>
                <article id={recipe.slug} className="scroll-mt-24">
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <div className="max-w-2xl">
                      <h2 className="font-medium font-sans text-2xl text-white leading-[1.2] tracking-[-0.02em]">
                        {recipe.title}
                      </h2>
                      <p className="mt-3 text-base text-white/60 leading-6">
                        {recipe.cardDescription}
                      </p>
                    </div>
                    <Link
                      href={`/docs/recipes/${recipe.slug}`}
                      className="group inline-flex shrink-0 items-center gap-1.5 rounded text-sm text-white/60 outline-none transition-colors hover:text-white focus-visible:ring-2 focus-visible:ring-accent sm:mt-1"
                    >
                      Full write-up
                      <ArrowUpRight
                        aria-hidden="true"
                        className="size-4 transition-transform duration-200 group-hover:translate-x-0.5"
                        strokeWidth={1.5}
                      />
                    </Link>
                  </div>
                  <div className="mt-6">
                    <CodeWindow
                      filename={primary.filename}
                      code={primary.code}
                    />
                    <p className="mt-4 max-w-2xl text-sm text-white/50 leading-6">
                      {primary.caption}
                    </p>
                  </div>
                </article>
              </Reveal>
            );
          })}
        </div>
      </Section>

      {/* Other categories — the "what about this?" jump-off */}
      <Section>
        <SectionHeading
          eyebrow="More categories"
          title="Browse another lifecycle stage"
        />
        <div className="mt-12 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {others.map((id, index) => {
            const other = RECIPE_CATEGORIES[id];
            const count = getRecipesByCategory(id).length;
            return (
              <Reveal key={id} delay={(index % 3) * 0.08} className="h-full">
                <Link
                  href={`/recipes/category/${id}`}
                  className="group block h-full"
                >
                  <Card className="flex h-full flex-col gap-3 group-hover:border-white/15">
                    <div className="flex items-baseline justify-between gap-3">
                      <h3 className="font-medium font-sans text-white text-xl leading-[1.2] tracking-[-0.02em]">
                        {other.title}
                      </h3>
                      <span className="shrink-0 text-sm text-white/40">
                        {count}
                      </span>
                    </div>
                    <p className="text-base text-white/60 leading-6">
                      {other.description}
                    </p>
                    <span className="mt-auto inline-flex items-center gap-1.5 pt-2 text-sm text-white/60 transition-colors group-hover:text-white">
                      Browse {other.title.toLowerCase()}
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
          })}
        </div>
        <Reveal delay={0.12}>
          <div className="mt-10">
            <Button href="/recipes" variant="outline" icon>
              All 28 recipes
            </Button>
          </div>
        </Reveal>
      </Section>

      <ClosingCta
        title="Copy a recipe into your app"
        subtitle="Paste any recipe straight into your codebase, or scaffold a fresh app with create-hogsend and build from there."
      />
    </main>
  );
}
