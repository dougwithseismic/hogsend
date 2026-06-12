import { ArrowUpRight, GitBranch, Megaphone, Send, Users } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import type { JSX, ReactNode } from "react";
import { Button } from "@/components/ds/button";
import { Card } from "@/components/ds/card";
import { Reveal } from "@/components/ds/reveal";
import { Section, SectionHeading } from "@/components/ds/section";

export const metadata: Metadata = {
  title: "Recipes",
  description:
    "Recipes for common Hogsend outcomes — transactional email, lifecycle journeys, campaigns, events and contacts — each built from a few primitives.",
};

const ICON_SIZE = 20;

type Recipe = {
  icon: ReactNode;
  title: string;
  description: string;
  href: string;
};

const RECIPES: Recipe[] = [
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

type Primitive = {
  label: string;
  href: string;
};

const PRIMITIVES: Primitive[] = [
  { label: "Journeys", href: "/docs/guides/journeys" },
  { label: "Buckets", href: "/docs/guides/buckets" },
  { label: "Email", href: "/docs/guides/email" },
  { label: "Destinations", href: "/docs/guides/destinations" },
];

export default function RecipesPage(): JSX.Element {
  return (
    <main className="flex flex-1 flex-col">
      {/* Heading + grid — plain section so pt-32 clears the fixed 80px nav
          (the shared Section rhythm would override it). Sits flush under the
          nav hairline, no divider. */}
      <section className="relative text-white">
        <div className="container-page pt-32 pb-20 md:pb-28">
          <Reveal>
            <SectionHeading
              eyebrow="Recipes"
              title="Recipes for the common outcomes"
              subtitle="Each outcome is a few primitives combined. Pick the result; the recipe shows the pieces."
            />
          </Reveal>

          <div className="mt-12 grid grid-cols-1 gap-6 sm:grid-cols-2 md:mt-16">
            {RECIPES.map((recipe, index) => (
              <Reveal key={recipe.href} delay={(index % 2) * 0.08}>
                <Link
                  href={recipe.href}
                  className="group block h-full rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-ink"
                >
                  <Card className="flex h-full flex-col gap-5 group-hover:border-white/15">
                    <div className="flex items-start justify-between gap-4">
                      <span className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-white/[0.08] bg-white/[0.04] text-white">
                        {recipe.icon}
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
                        {recipe.title}
                      </h3>
                      <p className="text-base text-white/60 leading-6">
                        {recipe.description}
                      </p>
                    </div>
                  </Card>
                </Link>
              </Reveal>
            ))}
          </div>

          {/* The primitives behind the recipes. */}
          <Reveal delay={0.1}>
            <div className="mt-14 flex flex-col gap-4 border-white/[0.08] border-t pt-8 md:mt-20 md:flex-row md:items-center md:justify-between">
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
        </div>
      </section>

      {/* Closing CTA. Full-bleed top hairline via Section. */}
      <Section id="recipes-cta">
        <Reveal>
          <SectionHeading
            align="center"
            eyebrow="Start cooking"
            title="Browse every recipe"
            subtitle="Read each recipe end to end, or scaffold an app and start from a working flow."
            className="mx-auto"
          />
        </Reveal>

        <Reveal
          delay={0.1}
          className="mt-12 flex flex-wrap items-center justify-center gap-x-8 gap-y-4"
        >
          <Button href="/docs/recipes" variant="accent" icon>
            Browse recipes
          </Button>
          <Button href="/docs/getting-started" variant="outline">
            Get started
          </Button>
        </Reveal>
      </Section>
    </main>
  );
}
