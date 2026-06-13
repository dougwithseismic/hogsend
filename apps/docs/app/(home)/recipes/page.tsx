import { ArrowUpRight, GitBranch, Megaphone, Send, Users } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import type { JSX, ReactNode } from "react";
import { Button } from "@/components/ds/button";
import { Card } from "@/components/ds/card";
import { Reveal } from "@/components/ds/reveal";
import { Section, SectionHeading } from "@/components/ds/section";
import { RecipeCard } from "./_components/recipe-sections";
import { RECIPE_LANDERS } from "./_data";
import { RECIPE_CATEGORIES, type RecipeCategoryId } from "./_data/types";

export const metadata: Metadata = {
  title: "Recipes",
  description:
    "A catalog of lifecycle email recipes in TypeScript — onboarding, carts, dunning, win-backs, human-in-the-loop approvals, and agent-driven flows, each a working journey you can drop into a scaffold.",
};

const ICON_SIZE = 20;

type Mode = {
  icon: ReactNode;
  title: string;
  description: string;
  href: string;
};

/** The four foundation pages: one per messaging mode / data primitive. */
const MODES: Mode[] = [
  {
    icon: <Send size={ICON_SIZE} strokeWidth={1.5} />,
    title: "Transactional emails",
    description:
      "Fire a single email from your app code on a server-side event — receipts, password resets, magic links.",
    href: "/docs/recipes/transactional-emails",
  },
  {
    icon: <GitBranch size={ICON_SIZE} strokeWidth={1.5} />,
    title: "Lifecycle journeys",
    description:
      "Multi-step sequences that wait, branch on behaviour, and exit themselves — welcome series, trial nudges, win-backs.",
    href: "/docs/recipes/lifecycle-journeys",
  },
  {
    icon: <Megaphone size={ICON_SIZE} strokeWidth={1.5} />,
    title: "Marketing campaigns",
    description:
      "Send a one-off broadcast to an audience, with preferences and unsubscribe handled for you.",
    href: "/docs/recipes/marketing-campaigns",
  },
  {
    icon: <Users size={ICON_SIZE} strokeWidth={1.5} />,
    title: "Events & contacts",
    description:
      "Push events and upsert contacts from anywhere, then trigger journeys and buckets off the stream.",
    href: "/docs/recipes/events-and-contacts",
  },
];

const CATEGORY_ORDER: RecipeCategoryId[] = [
  "onboarding",
  "conversion",
  "ecommerce",
  "retention",
  "scheduling",
  "human-in-the-loop",
  "agentic",
  "pipelines",
];

type Primitive = {
  label: string;
  href: string;
};

const PRIMITIVES: Primitive[] = [
  { label: "Journeys", href: "/docs/guides/journeys" },
  { label: "Buckets", href: "/docs/guides/buckets" },
  { label: "Email", href: "/docs/guides/email" },
  { label: "Semantic links", href: "/docs/guides/semantic-links" },
  { label: "Webhook sources", href: "/docs/guides/webhook-sources" },
  { label: "Destinations", href: "/docs/guides/destinations" },
];

export default function RecipesPage(): JSX.Element {
  return (
    <main className="flex flex-1 flex-col">
      {/* Heading + modes — plain section so pt-32 clears the fixed 80px nav
          (the shared Section rhythm would override it). Sits flush under the
          nav hairline, no divider. */}
      <section className="relative text-white">
        <div className="container-page pt-32 pb-20 md:pb-28">
          <Reveal>
            <SectionHeading
              eyebrow="Recipes"
              title="A recipe for every lifecycle outcome"
              subtitle="Each one is a working flow built from a few primitives — from a welcome series to human-approval gates and agent-driven sends. Pick the outcome; the recipe shows the code."
            />
          </Reveal>

          {/* The four modes every recipe builds on. */}
          <Reveal delay={0.08}>
            <p className="mt-12 text-white/50 text-xs uppercase tracking-[0.04em] md:mt-16">
              Start here — the four modes
            </p>
          </Reveal>
          <div className="mt-5 grid grid-cols-1 gap-6 sm:grid-cols-2">
            {MODES.map((mode, index) => (
              <Reveal key={mode.href} delay={(index % 2) * 0.08}>
                <Link
                  href={mode.href}
                  className="group block h-full rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-ink"
                >
                  <Card className="flex h-full flex-col gap-5 group-hover:border-white/15">
                    <div className="flex items-start justify-between gap-4">
                      <span className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-white/[0.08] bg-white/[0.04] text-white">
                        {mode.icon}
                      </span>
                      <ArrowUpRight
                        size={18}
                        strokeWidth={1.5}
                        className="text-white/30 transition-colors duration-200 group-hover:text-white/70"
                        aria-hidden="true"
                      />
                    </div>

                    <div className="flex flex-col gap-2.5">
                      <h3 className="font-medium text-white text-xl leading-[1.2] tracking-[-0.02em]">
                        {mode.title}
                      </h3>
                      <p className="text-base text-white/60 leading-6">
                        {mode.description}
                      </p>
                    </div>
                  </Card>
                </Link>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* The catalog, one section per category. */}
      {CATEGORY_ORDER.map((categoryId) => {
        const category = RECIPE_CATEGORIES[categoryId];
        const recipes = RECIPE_LANDERS.filter(
          (recipe) => recipe.category === categoryId,
        );
        if (recipes.length === 0) return null;

        const categoryHref = `/recipes/category/${categoryId}`;

        return (
          <Section
            key={categoryId}
            id={`recipes-${categoryId}`}
            className="scroll-mt-24"
          >
            <Reveal>
              <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
                <SectionHeading
                  eyebrow={`${recipes.length} ${recipes.length === 1 ? "recipe" : "recipes"}`}
                  title={category.title}
                  subtitle={category.description}
                />
                <Link
                  href={categoryHref}
                  className="group inline-flex shrink-0 items-center gap-1.5 rounded text-sm text-white/60 outline-none transition-colors hover:text-white focus-visible:ring-2 focus-visible:ring-accent sm:pb-1"
                >
                  Open category
                  <ArrowUpRight
                    aria-hidden="true"
                    className="size-4 transition-transform duration-200 group-hover:translate-x-0.5"
                    strokeWidth={1.5}
                  />
                </Link>
              </div>
            </Reveal>
            <div className="mt-12 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {recipes.map((recipe, index) => (
                <RecipeCard key={recipe.slug} recipe={recipe} index={index} />
              ))}
            </div>
          </Section>
        );
      })}

      {/* The primitives behind the recipes + closing CTA. */}
      <Section id="recipes-cta">
        <Reveal>
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <p className="text-white/50 text-xs uppercase tracking-[0.04em]">
              The primitives behind them
            </p>
            <div className="flex flex-wrap gap-2.5">
              {PRIMITIVES.map((primitive) => (
                <Link
                  key={primitive.href}
                  href={primitive.href}
                  className="inline-flex items-center rounded-[3px] border border-white/[0.08] bg-white/[0.06] px-2.5 py-1 text-white/80 text-xs outline-none transition-colors duration-200 hover:border-white/20 hover:text-white focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-ink"
                >
                  {primitive.label}
                </Link>
              ))}
            </div>
          </div>
        </Reveal>

        <Reveal delay={0.08}>
          <SectionHeading
            align="center"
            eyebrow="Start cooking"
            title="Every recipe is a file in your repo"
            subtitle="Read them end to end in the docs, or scaffold an app and start from a working flow."
            className="mx-auto mt-20"
          />
        </Reveal>

        <Reveal
          delay={0.16}
          className="mt-12 flex flex-wrap items-center justify-center gap-x-8 gap-y-4"
        >
          <Button href="/docs/recipes" variant="accent" icon>
            Browse recipes in the docs
          </Button>
          <Button href="/docs/getting-started" variant="outline">
            Get started
          </Button>
        </Reveal>
      </Section>
    </main>
  );
}
