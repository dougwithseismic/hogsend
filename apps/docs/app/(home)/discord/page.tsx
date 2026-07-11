import {
  ArrowUpRight,
  Clock,
  KeyRound,
  LayoutGrid,
  MessageSquare,
  Send,
  Users,
} from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import type { JSX, ReactNode } from "react";
import { Clip } from "@/components/clips/clip";
import { TagPill } from "@/components/ds/badge";
import { Button } from "@/components/ds/button";
import { Card } from "@/components/ds/card";
import { Reveal } from "@/components/ds/reveal";
import { Section, SectionHeading } from "@/components/ds/section";

export const metadata: Metadata = {
  title: "Discord",
  description:
    "Add a bot to your Discord server and Hogsend sees who joins, what " +
    "they post, and when they go quiet — on the same contact as their " +
    "email and product activity. Welcome new members, win back quiet " +
    "ones, and message them by email or back in Discord.",
  alternates: { canonical: "/discord" },
  keywords: [
    "discord automation",
    "discord bot",
    "community lifecycle",
    "posthog",
    "lifecycle email",
    "email automation",
    "win-back emails",
    "customer lifecycle",
  ],
};

const ICON_SIZE = 20;

/**
 * Card mark: a lucide icon in the standard 40px square. There is no `discord`
 * BrandKey / SVG, so the page uses the icon escape hatch throughout.
 */
function CardMark({ icon }: { icon: ReactNode }): JSX.Element {
  return (
    <span className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-white/[0.08] bg-white/[0.04] text-white">
      {icon}
    </span>
  );
}

type Feature = {
  icon: ReactNode;
  title: string;
  body: string;
  /** Small chip naming the capability in user terms. */
  tag: string;
};

/**
 * Capability card: a 40px icon mark, a 20px/500 title, one line of body, and
 * a small chip pinned to the bottom.
 */
function FeatureCard({ feature }: { feature: Feature }): JSX.Element {
  return (
    <Card className="flex h-full flex-col gap-5">
      <CardMark icon={feature.icon} />

      <div className="flex flex-col gap-2.5">
        <h3 className="font-medium text-white text-xl leading-[1.2] tracking-[-0.02em]">
          {feature.title}
        </h3>
        <p className="text-base text-white/60 leading-6">{feature.body}</p>
      </div>

      <span className="mt-auto pt-1">
        <TagPill>{feature.tag}</TagPill>
      </span>
    </Card>
  );
}

function FeatureGrid({ items }: { items: Feature[] }): JSX.Element {
  return (
    <div className="mt-12 grid grid-cols-1 gap-6 sm:grid-cols-2 md:mt-16 md:grid-cols-3">
      {items.map((feature, index) => (
        <Reveal key={feature.title} delay={(index % 3) * 0.08}>
          <FeatureCard feature={feature} />
        </Reveal>
      ))}
    </div>
  );
}

const CAPABILITIES: Feature[] = [
  {
    icon: <Users size={ICON_SIZE} strokeWidth={1.5} />,
    title: "Welcome people who join",
    body: "A member joining your server starts a journey, so the first touch is automatic.",
    tag: "on join",
  },
  {
    icon: <MessageSquare size={ICON_SIZE} strokeWidth={1.5} />,
    title: "Act on what they say",
    body: "Messages and reactions become events you can trigger journeys on.",
    tag: "messages + reactions",
  },
  {
    icon: <Clock size={ICON_SIZE} strokeWidth={1.5} />,
    title: "Win back quiet members",
    body: "Hogsend tracks when each member was last active, so you can re-engage the ones who went quiet.",
    tag: "last active",
  },
  {
    icon: <KeyRound size={ICON_SIZE} strokeWidth={1.5} />,
    title: "Link a Discord account to an email",
    body: "A member runs /link and clicks the one-click confirm link from their inbox — now they're emailable too.",
    tag: "/link",
  },
  {
    icon: <Send size={ICON_SIZE} strokeWidth={1.5} />,
    title: "Message them in Discord",
    body: "Post lifecycle messages straight to a Discord channel, alongside the emails you already send.",
    tag: "in-channel",
  },
  {
    icon: <LayoutGrid size={ICON_SIZE} strokeWidth={1.5} />,
    title: "One profile across everything",
    body: "Discord sits next to email, product activity, and PostHog on a single contact.",
    tag: "one contact",
  },
];

type Recipe = {
  title: string;
  body: string;
  href: string;
};

const DISCORD_RECIPES: Recipe[] = [
  {
    title: "Welcome new members",
    body: "Trigger a welcome the moment a member joins and links an email.",
    href: "/docs/recipes/welcome-new-discord-members",
  },
  {
    title: "Win back quiet members",
    body: "Email the members who've gone quiet, using when they were last active.",
    href: "/docs/recipes/re-engage-quiet-discord-members",
  },
  {
    title: "Link Discord to email",
    body: "Let a member tie their Discord account to an email with a one-click confirm link.",
    href: "/docs/recipes/link-discord-to-email",
  },
  {
    title: "Engagement alerts",
    body: "Post hand-raises, complaints, and finished journeys to a Discord channel.",
    href: "/docs/recipes/discord-engagement-alerts",
  },
  {
    title: "Reaction as a signal",
    body: "Turn a specific reaction into a lead an operator follows up on.",
    href: "/docs/recipes/route-a-reaction-as-a-signal",
  },
];

function RecipeCard({
  recipe,
  index,
}: {
  recipe: Recipe;
  index: number;
}): JSX.Element {
  return (
    <Reveal delay={(index % 3) * 0.08}>
      <Link href={recipe.href} className="group block h-full">
        <Card className="flex h-full flex-col gap-3">
          <h3 className="font-medium font-sans text-white text-xl leading-[1.2] tracking-[-0.02em]">
            {recipe.title}
          </h3>
          <p className="text-base text-white/60 leading-6">{recipe.body}</p>
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

export default function DiscordPage(): JSX.Element {
  return (
    <main className="flex flex-1 flex-col">
      {/* Hero — plain section so pt-32 clears the fixed 80px nav (the shared
          Section rhythm would override it). Sits flush under the nav hairline,
          no divider. */}
      <section className="relative text-white">
        <div className="container-page pt-32 pb-20">
          <Reveal>
            <SectionHeading
              eyebrow="Discord"
              title="Integrate Discord into your lifecycle marketing"
              subtitle="Add a bot to your Discord server and Hogsend sees who joins, what they post, and when they go quiet — on the same contact as their email and product activity. Then message them, by email or back in Discord."
            />
          </Reveal>
        </div>
      </section>

      {/* Lead clip — a member joins, links an email, the welcome lands. */}
      <Section id="in-motion">
        <Reveal>
          <SectionHeading
            eyebrow="In motion"
            title="Someone joins. Hogsend takes it from there."
            subtitle="A member joins your server, links their email with one click, and the welcome lands the moment they do — one continuous run."
          />
        </Reveal>

        <Reveal className="mt-12">
          <Clip
            clip="discord-welcome"
            title="A new Discord member, welcomed the moment they link an email"
          />
        </Reveal>
      </Section>

      {/* What you can do — the six capability cards. */}
      <Section id="what-you-can-do">
        <Reveal>
          <SectionHeading
            eyebrow="What you can do"
            title="Six things it does the day you turn it on"
          />
        </Reveal>

        <FeatureGrid items={CAPABILITIES} />
      </Section>

      {/* Second clip — the /link one-click email-confirm flow. */}
      <Section id="linking">
        <Reveal>
          <SectionHeading
            eyebrow="Linking"
            title="Tie a Discord account to an email — /link, then one click"
            subtitle="The member runs /link, types their email into a private modal, and clicks the one-click confirm link in their inbox — the two become one contact, and they get the verified role."
          />
        </Reveal>

        <Reveal className="mt-12">
          <Clip
            clip="discord-link"
            title="Link a Discord account to an email with a one-click confirm link"
          />
        </Reveal>
      </Section>

      {/* Setup — one line + a docs link (the real steps live in the docs). */}
      <Section id="setup">
        <Reveal>
          <SectionHeading
            eyebrow="Get started"
            title="Set it up"
            subtitle="Create a Discord bot, invite it to your server, paste the keys, and run it. The full walkthrough is in the docs."
          />
        </Reveal>

        <Reveal
          delay={0.1}
          className="mt-8 flex flex-wrap items-center gap-x-8 gap-y-4"
        >
          <Button href="/docs/integrations/discord" variant="accent" icon>
            Setup guide
          </Button>
          <Button href="/docs/recipes" variant="outline">
            Browse recipes
          </Button>
        </Reveal>
      </Section>

      {/* Recipes — the five Discord recipes, each linking to its walkthrough. */}
      <Section id="recipes">
        <Reveal>
          <SectionHeading
            eyebrow="Recipes"
            title="Five things to build with it"
            subtitle="Copy-paste journeys and wiring — each one is a full walkthrough in the docs."
          />
        </Reveal>

        <div className="mt-12 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {DISCORD_RECIPES.map((recipe, index) => (
            <RecipeCard key={recipe.href} recipe={recipe} index={index} />
          ))}
        </div>
      </Section>
    </main>
  );
}
