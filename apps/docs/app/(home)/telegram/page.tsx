import {
  ArrowUpRight,
  Clock,
  KeyRound,
  LayoutGrid,
  Mail,
  MessageSquare,
  Send,
} from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import type { JSX, ReactNode } from "react";
import { TagPill } from "@/components/ds/badge";
import { Button } from "@/components/ds/button";
import { Card } from "@/components/ds/card";
import { Reveal } from "@/components/ds/reveal";
import { Section, SectionHeading } from "@/components/ds/section";

export const metadata: Metadata = {
  title: "Telegram",
  description:
    "Point a Telegram bot at Hogsend and inbound messages and /start " +
    "deep-links become events your journeys trigger on — on the same " +
    "contact as their email and product activity. Journeys reply with " +
    "sendMessage and dm, and a member can bind their Telegram to an email " +
    "with /link.",
  alternates: { canonical: "/telegram" },
  keywords: [
    "telegram automation",
    "telegram bot",
    "lifecycle email",
    "posthog",
    "email automation",
    "customer lifecycle",
    "messaging automation",
    "community lifecycle",
  ],
};

const ICON_SIZE = 20;

/**
 * Card mark: a lucide icon in the standard 40px square. There is no `telegram`
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
    icon: <MessageSquare size={ICON_SIZE} strokeWidth={1.5} />,
    title: "Act on what they send",
    body: "Inbound messages become telegram.message events you can trigger journeys on.",
    tag: "telegram.message",
  },
  {
    icon: <Send size={ICON_SIZE} strokeWidth={1.5} />,
    title: "Welcome people who /start",
    body: "A /start deep-link starts a journey, so the first reply is automatic.",
    tag: "/start",
  },
  {
    icon: <KeyRound size={ICON_SIZE} strokeWidth={1.5} />,
    title: "Reply from your journeys",
    body: "Journeys answer with sendMessage and dm through sendConnectorAction.",
    tag: "sendMessage + dm",
  },
  {
    icon: <Mail size={ICON_SIZE} strokeWidth={1.5} />,
    title: "Bind a Telegram account to an email",
    body: "A member runs /link you@example.com, clicks the emailed confirmation link, and they're emailable too.",
    tag: "/link",
  },
  {
    icon: <Clock size={ICON_SIZE} strokeWidth={1.5} />,
    title: "Identify from the member's device",
    body: "The PostHog identify fires client-side on confirm, so the location is the member's, not your datacenter's.",
    tag: "client-side identify",
  },
  {
    icon: <LayoutGrid size={ICON_SIZE} strokeWidth={1.5} />,
    title: "One profile across everything",
    body: "Telegram sits next to email, product activity, and PostHog on a single contact via telegram:<id>.",
    tag: "one contact",
  },
];

type Recipe = {
  title: string;
  body: string;
  href: string;
};

const TELEGRAM_RECIPES: Recipe[] = [
  {
    title: "Welcome new members",
    body: "Trigger a welcome the moment someone /starts your bot.",
    href: "/docs/recipes/welcome-new-telegram-members",
  },
  {
    title: "Link Telegram to email",
    body: "Let a member tie their Telegram account to an email with a confirmation link.",
    href: "/docs/recipes/link-telegram-to-email",
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

export default function TelegramPage(): JSX.Element {
  return (
    <main className="flex flex-1 flex-col">
      {/* Hero — plain section so pt-32 clears the fixed 80px nav (the shared
          Section rhythm would override it). Sits flush under the nav hairline,
          no divider. */}
      <section className="relative text-white">
        <div className="container-page pt-32 pb-20">
          <Reveal>
            <SectionHeading
              eyebrow="Messages and /start links in, journey replies out."
              title="Integrate Telegram into your lifecycle marketing"
              subtitle="Inbound messages and /start deep-links become events your journeys trigger on; journeys reply with sendMessage / dm. A member whose email you don't have sends /link you@example.com, clicks the emailed confirmation link, and their Telegram binds to your contact — the PostHog identify fires client-side, so the location is the member's, not your datacenter's. It's a defineConnector in your repo."
            />
          </Reveal>
        </div>
      </section>

      {/* How it works — the inbound webhook → events → journey-reply spine. */}
      <Section id="how-it-works">
        <Reveal>
          <SectionHeading
            eyebrow="How it works"
            title="A bot, a webhook, and your journeys"
            subtitle="Point a Telegram bot at POST /v1/webhooks/telegram with TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET. Inbound updates become telegram.message, telegram.started, telegram.linked, and telegram.link_requested events; journeys reply with sendMessage and dm. It's domain-agnostic — any Telegram bot, any topic."
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

      {/* Linking — the /link email-confirm cold connect. */}
      <Section id="linking">
        <Reveal>
          <SectionHeading
            eyebrow="Linking"
            title="Bind a Telegram account to an email — by clicking a link"
            subtitle="A member whose email you don't have sends /link you@example.com. Hogsend emails a confirmation link; clicking it binds their Telegram to your contact and fires the PostHog identify client-side, keyed to a server-proven contact key — so the location is the member's, not your datacenter's."
          />
        </Reveal>
      </Section>

      {/* Setup — one line + a docs link (the real steps live in the docs). */}
      <Section id="setup">
        <Reveal>
          <SectionHeading
            eyebrow="Get started"
            title="Set it up"
            subtitle="Create a Telegram bot with BotFather, point its webhook at Hogsend, paste TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET, and run it. The full walkthrough is in the docs."
          />
        </Reveal>

        <Reveal
          delay={0.1}
          className="mt-8 flex flex-wrap items-center gap-x-8 gap-y-4"
        >
          <Button href="/docs/integrations/telegram" variant="accent" icon>
            Setup guide
          </Button>
          <Button href="/docs/recipes" variant="outline">
            Browse recipes
          </Button>
        </Reveal>
      </Section>

      {/* Recipes — the two Telegram recipes, each linking to its walkthrough. */}
      <Section id="recipes">
        <Reveal>
          <SectionHeading
            eyebrow="Recipes"
            title="Two things to build with it"
            subtitle="Copy-paste journeys and wiring — each one is a full walkthrough in the docs."
          />
        </Reveal>

        <div className="mt-12 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {TELEGRAM_RECIPES.map((recipe, index) => (
            <RecipeCard key={recipe.href} recipe={recipe} index={index} />
          ))}
        </div>
      </Section>
    </main>
  );
}
