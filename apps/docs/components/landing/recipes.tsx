import { CreditCard, GitBranch, Megaphone, Users } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ds/button";
import { Card } from "@/components/ds/card";
import { Reveal } from "@/components/ds/reveal";
import { Section, SectionHeading } from "@/components/ds/section";

type Recipe = {
  icon: React.ReactNode;
  title: string;
  description: string;
  href: string;
};

const ICON_SIZE = 20;

const RECIPES: Recipe[] = [
  {
    icon: <CreditCard size={ICON_SIZE} strokeWidth={1.5} />,
    title: "Transactional emails",
    description:
      "Receipts, password resets, magic links — one email fired on one event.",
    href: "/docs/recipes/transactional-emails",
  },
  {
    icon: <GitBranch size={ICON_SIZE} strokeWidth={1.5} />,
    title: "Lifecycle journeys",
    description:
      "Welcome, activation, trial-to-paid, churn recovery — multi-step sequences in code.",
    href: "/docs/recipes/lifecycle-journeys",
  },
  {
    icon: <Megaphone size={ICON_SIZE} strokeWidth={1.5} />,
    title: "Marketing campaigns",
    description:
      "Broadcast a template to a subscription list or a real-time bucket.",
    href: "/docs/recipes/marketing-campaigns",
  },
  {
    icon: <Users size={ICON_SIZE} strokeWidth={1.5} />,
    title: "Events & contacts",
    description:
      "Get events and contacts in — from PostHog, Stripe, or your own app.",
    href: "/docs/recipes/events-and-contacts",
  },
];

/**
 * "Recipes" — surface the cookbook on the lander. Each card links the matching
 * recipe doc; the model from the primitives pays off in concrete outcomes.
 */
export function Recipes() {
  return (
    <Section tone="dark" id="recipes">
      <Reveal>
        <SectionHeading
          eyebrow="RECIPES"
          title="A cookbook, not a blank page"
          subtitle="Every outcome is a few primitives combined. Pick the result, reach for the pieces, write the code."
        />
      </Reveal>

      <div className="mt-12 grid grid-cols-1 gap-5 sm:grid-cols-2 md:mt-16 lg:grid-cols-4">
        {RECIPES.map((recipe, index) => (
          <Reveal key={recipe.title} delay={(index % 4) * 0.06}>
            <Link
              href={recipe.href}
              className="group block h-full rounded-[10px] outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <Card
                ticks
                className="h-full transition-colors group-hover:border-white/20 group-hover:bg-white/[0.04]"
              >
                <div className="flex size-10 items-center justify-center rounded-[8px] border border-white/10 bg-white/[0.03]">
                  {recipe.icon}
                </div>
                <h3 className="mt-4 font-display text-lg">{recipe.title}</h3>
                <p className="mt-2 text-sm text-white/60">
                  {recipe.description}
                </p>
              </Card>
            </Link>
          </Reveal>
        ))}
      </div>

      <Reveal delay={0.1}>
        <div className="mt-10 flex justify-center">
          <Button href="/recipes" variant="accent" icon>
            Browse the cookbook
          </Button>
        </div>
      </Reveal>
    </Section>
  );
}
