import {
  KeyRound,
  Link2,
  MessageSquare,
  Send,
  Server,
  Users,
} from "lucide-react";
import type { Metadata } from "next";
import type { JSX, ReactNode } from "react";
import { TagPill } from "@/components/ds/badge";
import { Button } from "@/components/ds/button";
import { Card } from "@/components/ds/card";
import { CodeWindow } from "@/components/ds/code-window";
import { Reveal } from "@/components/ds/reveal";
import { Section, SectionHeading } from "@/components/ds/section";

export const metadata: Metadata = {
  title: "Discord",
  description:
    "@hogsend/plugin-discord has an inbound Gateway worker and an outbound " +
    "destination. The Gateway worker turns Discord messages, reactions, " +
    "joins, and presence into discord.* events on a contact; the " +
    "destination posts lifecycle events to a channel. Discord activity " +
    "lands on the same contact as your app events, email engagement, and " +
    "PostHog.",
};

const ICON_SIZE = 20;

/**
 * Card mark: a lucide icon in the standard 40px square. There is no `discord`
 * BrandKey / SVG, so the page uses the icon escape hatch throughout (no new
 * assets).
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
  /** Body lines — each is its own paragraph. */
  lines: string[];
  /** Small chip describing the wire. */
  tag: string;
};

/**
 * Feature card: a 40px icon mark, a 20px/500 title, one paragraph per body
 * line, and a small 3px-radius wire chip pinned to the bottom.
 */
function FeatureCard({ feature }: { feature: Feature }): JSX.Element {
  return (
    <Card className="flex h-full flex-col gap-5">
      <CardMark icon={feature.icon} />

      <div className="flex flex-col gap-2.5">
        <h3 className="font-medium text-white text-xl leading-[1.2] tracking-[-0.02em]">
          {feature.title}
        </h3>
        {feature.lines.map((line) => (
          <p key={line} className="text-base text-white/60 leading-6">
            {line}
          </p>
        ))}
      </div>

      <span className="mt-auto pt-1">
        <TagPill>{feature.tag}</TagPill>
      </span>
    </Card>
  );
}

function FeatureGrid({ items }: { items: Feature[] }): JSX.Element {
  return (
    <div className="mt-12 grid grid-cols-1 gap-6 sm:grid-cols-2 md:mt-16">
      {items.map((feature, index) => (
        <Reveal key={feature.title} delay={(index % 2) * 0.08}>
          <FeatureCard feature={feature} />
        </Reveal>
      ))}
    </div>
  );
}

const FACES: Feature[] = [
  {
    icon: <MessageSquare size={ICON_SIZE} strokeWidth={1.5} />,
    title: "Gateway worker — events in",
    lines: [
      "A separate Gateway worker process logs in with the bot token, dials " +
        "Discord over a WebSocket, and POSTs each dispatch to the API.",
      "Four dispatches become events: discord.message_sent, " +
        "discord.reaction_added, discord.member_joined, " +
        "discord.presence_active.",
      "Each event runs the same ingestion pipeline as PostHog and the REST " +
        "API — stored in user_events, routed to journeys, exit-checked, " +
        "upserted onto a contact.",
    ],
    tag: "Gateway worker",
  },
  {
    icon: <Send size={ICON_SIZE} strokeWidth={1.5} />,
    title: "Destination — events out",
    lines: [
      "discordDestination posts one Discord-markdown line per lifecycle " +
        "event to a channel.",
      "Incoming webhook URL (no bot token) or bot-REST with the bot token.",
      "It subscribes to the full lifecycle catalog: contact.*, email.* " +
        "(sent, delivered, opened, clicked, action, bounced, complained), " +
        "journey.completed, and bucket.entered / left.",
    ],
    tag: "defineDestination()",
  },
];

const IDENTITY: Feature[] = [
  {
    icon: <Users size={ICON_SIZE} strokeWidth={1.5} />,
    title: "Four identity keys",
    lines: [
      "external_id is your app's user. email is the universal key. " +
        "anonymous_id bridges pre-signup. discord_id is the Discord " +
        "snowflake, held on a partial unique index on contacts.discord_id.",
    ],
    tag: "discord_id",
  },
  {
    icon: <MessageSquare size={ICON_SIZE} strokeWidth={1.5} />,
    title: "Discord metadata on the contact",
    lines: [
      "Discord metadata lands under contacts.properties.discord: id, " +
        "username, global_name, avatar, last_seen.",
      "last_seen is derived first-party — Discord has no last-seen field, " +
        "so Hogsend stamps it from the max observed event timestamp.",
    ],
    tag: "contacts.properties.discord",
  },
];

const LINKING: Feature[] = [
  {
    icon: <KeyRound size={ICON_SIZE} strokeWidth={1.5} />,
    title: "/link — in Discord (recommended)",
    lines: [
      "A contact links their email inside Discord with the /link slash " +
        "command.",
      "The flow is a private modal loop: /link opens an email modal; a " +
        'valid address emails a 6-digit code and shows an "Enter code" ' +
        "button; the button opens a code modal; submitting it links the " +
        "account and shows a success card. Every step is ephemeral.",
      "The code is single-use, has a 15-minute TTL, is bound to the " +
        "invoking Discord user, and is hashed at rest. /verify <code> is " +
        "the typed fallback.",
      "Runs env-only — no extra credential, no CLI.",
    ],
    tag: "/link slash command",
  },
  {
    icon: <Link2 size={ICON_SIZE} strokeWidth={1.5} />,
    title: "OAuth member-link — from your app (optional)",
    lines: [
      'A "Connect Discord" button from your web app. The engine mints the ' +
        "link at POST /v1/admin/connectors/discord/member-link-url; the " +
        "user authorizes (scope identify email guilds.members.read); the " +
        "callback attaches discord_id to the bound contact.",
      "The contact is identified by the email the link was issued for, " +
        "never the OAuth-reported Discord email.",
      "Use this when linking starts on the web rather than inside Discord.",
    ],
    tag: "OAuth member-link",
  },
];

/** The .env block from the docs Setup section — verbatim, copyable. */
const ENV_SNIPPET = `DISCORD_APPLICATION_ID=...
DISCORD_PUBLIC_KEY=...
DISCORD_BOT_TOKEN=...          # secret — the Gateway worker logs in with this
DISCORD_CLIENT_SECRET=...      # secret — OAuth member-link only
DISCORD_GUILD_ID=...           # optional — instant guild-scoped command registration

API_PUBLIC_URL=https://api.example.com   # public host, not loopback
CONNECTOR_INGRESS_SECRET=...             # >= 32 chars; shared by the worker + ingress route`;

export default function DiscordPage(): JSX.Element {
  return (
    <main className="flex flex-1 flex-col">
      {/* Heading — plain section so pt-32 clears the fixed 80px nav (the
          shared Section rhythm would override it). Sits flush under the nav
          hairline, no divider. */}
      <section className="relative text-white">
        <div className="container-page pt-32 pb-20">
          <Reveal>
            <SectionHeading
              eyebrow="Discord"
              title="Discord activity on the same contact as everything else"
              subtitle="@hogsend/plugin-discord has an inbound Gateway worker that turns Discord messages, reactions, joins, and presence into discord.* events, and an outbound destination that posts lifecycle events to a Discord channel. Both resolve to the same contact as your app events, email engagement, and PostHog."
            />
          </Reveal>
        </div>
      </section>

      {/* What it does — the In / Out grid. */}
      <Section id="what-it-does">
        <Reveal>
          <SectionHeading
            eyebrow="In and out"
            title="A Gateway worker in, a destination out"
            subtitle='The package mounts under meta.id = "discord" and is consumer-mounted — pnpm add it and wire it into your app. The engine ships no Discord code.'
          />
        </Reveal>

        <FeatureGrid items={FACES} />
      </Section>

      {/* Unified contact — the identity value. */}
      <Section id="unified-contact">
        <Reveal>
          <SectionHeading
            eyebrow="Identity"
            title="discord_id is a fourth contact identity key"
            subtitle="discord_id is a fourth contact identity Kind (external | email | anonymous | discord). Identity resolves on shared keys, so Discord activity merges onto the contact your app already knows."
          />
        </Reveal>

        <FeatureGrid items={IDENTITY} />

        <Reveal delay={0.16} className="mt-6">
          <Card>
            <p className="text-base text-white/60 leading-6">
              A journey can trigger on discord.reaction_added and send a Resend
              email, or trigger on a billing event and post to a Discord channel
              with discordDestination.
            </p>
          </Card>
        </Reveal>
      </Section>

      {/* Linking — the two paths, /link first. */}
      <Section id="linking">
        <Reveal>
          <SectionHeading
            eyebrow="Linking a contact"
            title="Two ways to attach a Discord account to a contact"
            subtitle="Two paths: the in-Discord /link slash command, and a web-initiated OAuth member-link. /link needs no extra credential beyond the bot; the OAuth path needs DISCORD_CLIENT_SECRET."
          />
        </Reveal>

        <FeatureGrid items={LINKING} />
      </Section>

      {/* Self-hosted truth — single-tenant + privileged intents. */}
      <Section id="self-hosted">
        <Reveal>
          <SectionHeading
            eyebrow="Self-hosted"
            title="Each deploy runs its own Discord app"
            subtitle="Each self-hosted deploy runs its own single-tenant Discord app."
          />
        </Reveal>

        <Reveal delay={0.1} className="mt-12 md:mt-16">
          <Card className="flex flex-col gap-5">
            <CardMark icon={<Server size={ICON_SIZE} strokeWidth={1.5} />} />
            <ul className="flex flex-col gap-4">
              <li className="text-base text-white/60 leading-6">
                The four events need three privileged Gateway intents: Message
                Content, Server Members, Presence.
              </li>
              <li className="text-base text-white/60 leading-6">
                Under 10,000 users / 100 guilds these three are a self-serve
                toggle in the Developer Portal — no Discord review or
                verification at that scale. This is Discord policy, not a
                Hogsend limit.
              </li>
              <li className="text-base text-white/60 leading-6">
                Discord's terms still bind: a public privacy policy, user
                opt-out and deletion, data minimization, no ML-training on
                message content. Hogsend stores derived signals — last_seen,
                counts, metadata — not raw message bodies.
              </li>
            </ul>
          </Card>
        </Reveal>
      </Section>

      {/* Get started — env snippet + setup-guide pointer (single closing
          section, one "Get started" eyebrow per page). */}
      <Section id="setup">
        <Reveal>
          <SectionHeading
            eyebrow="Get started"
            title="Set it up"
            subtitle="pnpm add @hogsend/plugin-discord, register it in your app, run the Gateway worker, and post lifecycle events with discordDestination."
          />
        </Reveal>

        <Reveal delay={0.1} className="mt-12 md:mt-16">
          <CodeWindow filename=".env" lang="bash" code={ENV_SNIPPET} />
        </Reveal>

        <Reveal
          delay={0.16}
          className="mt-8 flex flex-wrap items-center gap-x-8 gap-y-4"
        >
          <Button href="/docs/integrations/discord" variant="accent" icon>
            Setup guide
          </Button>
          <Button href="/docs/guides/destinations" variant="outline">
            Destinations
          </Button>
          <Button href="/docs/recipes" variant="outline">
            Recipes
          </Button>
        </Reveal>
      </Section>
    </main>
  );
}
