import {
  ArrowUpRight,
  Boxes,
  GitBranch,
  Megaphone,
  Send,
  Users,
} from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import type { JSX, ReactNode } from "react";
import { Button } from "@/components/ds/button";
import { Card } from "@/components/ds/card";
import { Reveal } from "@/components/ds/reveal";
import { Section, SectionHeading } from "@/components/ds/section";

export const metadata: Metadata = {
  title: "Recipes — Hogsend",
  description:
    "A cookbook for Hogsend. Pick an outcome — transactional email, lifecycle journeys, campaigns, events and contacts — and reach for the primitives that build it.",
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
      {/* Heading — extra top padding clears the fixed 68px nav. */}
      <Section tone="dark" containerClassName="container-page pt-32 pb-20">
        <Reveal>
          <SectionHeading
            tone="dark"
            eyebrow="RECIPES"
            title="A cookbook, not a blank page"
            subtitle="Every outcome is a few primitives combined — pick the result, reach for the pieces."
          />
        </Reveal>

        <div className="mt-12 grid grid-cols-1 gap-5 sm:grid-cols-2 md:mt-16">
          {RECIPES.map((recipe, index) => (
            <Reveal key={recipe.href} delay={(index % 2) * 0.08}>
              <Link
                href={recipe.href}
                className="group block h-full rounded-[10px] outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-ink"
              >
                <Card
                  tone="dark"
                  ticks
                  className="h-full gap-5 transition-colors duration-200 group-hover:border-white/20 group-hover:bg-white/[0.04]"
                >
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

                  <div className="mt-5 flex flex-col gap-2.5">
                    <h3 className="font-display text-xl leading-[1.2] text-white">
                      {recipe.title}
                    </h3>
                    <p className="text-sm leading-relaxed text-white/60 md:text-base">
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
            <p className="font-mono text-white/40 text-xs uppercase tracking-wide">
              The primitives behind them
            </p>
            <div className="flex flex-wrap gap-2.5">
              {PRIMITIVES.map((primitive) => (
                <Link
                  key={primitive.href}
                  href={primitive.href}
                  className="inline-flex items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-sm text-white/70 outline-none transition-colors duration-200 hover:border-white/20 hover:bg-white/[0.05] hover:text-white focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-ink"
                >
                  <Boxes size={14} strokeWidth={1.5} aria-hidden="true" />
                  {primitive.label}
                </Link>
              ))}
            </div>
          </div>
        </Reveal>
      </Section>

      {/* Closing CTA. */}
      <Section tone="dark">
        <Reveal>
          <SectionHeading
            tone="dark"
            align="center"
            eyebrow="START COOKING"
            title="Browse the full cookbook"
            subtitle="Read every recipe end to end, or scaffold an app and start from a working flow."
            className="mx-auto"
          />
        </Reveal>

        <Reveal
          delay={0.1}
          className="mt-9 flex flex-wrap items-center justify-center gap-4"
        >
          <Button href="/docs/recipes" variant="accent" icon>
            Browse recipes
          </Button>
          <Button href="/docs/getting-started" variant="outline" tone="dark">
            Get started
          </Button>
        </Reveal>
      </Section>
    </main>
  );
}
