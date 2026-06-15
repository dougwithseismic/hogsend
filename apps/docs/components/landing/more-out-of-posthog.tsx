import {
  Fingerprint,
  Layers,
  MailCheck,
  MessageSquare,
  UserCog,
  Zap,
} from "lucide-react";
import type { JSX, ReactNode } from "react";
import { Clip } from "@/components/clips/clip";
import { TagPill } from "@/components/ds/badge";
import { Button } from "@/components/ds/button";
import { Card } from "@/components/ds/card";
import { Reveal } from "@/components/ds/reveal";
import { Section, SectionHeading } from "@/components/ds/section";

const ICON_SIZE = 20;

/**
 * Card mark: a lucide icon in the standard 40px square. Mirrors the discord
 * page's icon escape hatch — there are no brand SVGs for these capabilities.
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
    icon: <MailCheck size={ICON_SIZE} strokeWidth={1.5} />,
    title: "Engagement becomes PostHog events",
    body: "Every send, open and click fans back as a first-party event. Build cohorts and funnels on email behaviour.",
    tag: "first-party tracking",
  },
  {
    icon: <MessageSquare size={ICON_SIZE} strokeWidth={1.5} />,
    title: "Follow people into Discord",
    body: "See who joins, who's talking, and who's gone quiet — on the same contact as their email and product activity.",
    tag: "discord presence",
  },
  {
    icon: <UserCog size={ICON_SIZE} strokeWidth={1.5} />,
    title: "Write answers back onto the person",
    body: "An NPS score, a survey reply, a milestone — written back with identify() onto the PostHog person.",
    tag: "person properties",
  },
  {
    icon: <Zap size={ICON_SIZE} strokeWidth={1.5} />,
    title: "Triggered off events you already have",
    body: "Journeys react to your PostHog events directly. No reverse-ETL, no sync lag, no second source of truth.",
    tag: "no second pipeline",
  },
  {
    icon: <Layers size={ICON_SIZE} strokeWidth={1.5} />,
    title: "One profile across everything",
    body: "Email, product activity, Discord and PostHog sit on a single contact.",
    tag: "one contact",
  },
  {
    icon: <Fingerprint size={ICON_SIZE} strokeWidth={1.5} />,
    title: "Identities stitched together",
    body: "discord_id, email and anonymous IDs fold into one person as you learn who they are.",
    tag: "identity",
  },
];

/**
 * MoreOutOfPostHog — the "everything here makes PostHog better" deck. Hogsend
 * reads the PostHog events you already have and writes new ones back — email
 * engagement, Discord presence, identity, person-property write-backs — all on
 * the same PostHog person, with no second data pipeline.
 */
export function MoreOutOfPostHog({
  className,
}: {
  className?: string;
}): JSX.Element {
  return (
    <Section id="more-out-of-posthog" className={className}>
      <Reveal>
        <SectionHeading
          eyebrow="Built on PostHog"
          title="Everything here makes PostHog better"
          subtitle="Hogsend reads the events you already have and writes new ones back. Email engagement, Discord presence, and answers all land on the same PostHog person — no second pipeline, no reverse-ETL."
        />
      </Reveal>

      <Reveal className="mt-12">
        <Clip
          clip="first-party-tracking"
          title="Links rewritten on send — every open and click fans back to PostHog as a first-party event"
        />
      </Reveal>

      <FeatureGrid items={CAPABILITIES} />

      <Reveal className="mt-12 md:mt-16">
        <Clip
          clip="journey-posthog"
          title="A survey answer written back onto the PostHog person with identify()"
        />
      </Reveal>

      <Reveal delay={0.1} className="mt-12">
        <Button href="/discord" variant="outline" icon>
          The Discord integration
        </Button>
      </Reveal>
    </Section>
  );
}
