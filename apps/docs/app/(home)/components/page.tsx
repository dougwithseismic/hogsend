import {
  Code2,
  MessageCircle,
  Palette,
  Send,
  SlidersHorizontal,
} from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Clip } from "@/components/clips/clip";
import { Eyebrow } from "@/components/ds/badge";
import { Button } from "@/components/ds/button";
import { Card, FeatureCard } from "@/components/ds/card";
import { CodeWindow } from "@/components/ds/code-window";
import { CopyButton } from "@/components/ds/copy-button";
import { AuroraBeam, DotGrid } from "@/components/ds/fx";
import { Reveal } from "@/components/ds/reveal";
import { Section, SectionHeading } from "@/components/ds/section";
import { TabbedShowcase } from "@/components/ds/tabs";
import { PreferenceCenterDemo } from "@/components/hogsend/preference-center-demo";
import { SurveyDemo } from "@/components/hogsend/survey-demo";
import { SURVEY_SRC } from "@/components/hogsend/survey-demo-src";
import { GITHUB_URL, RAILWAY_DEPLOY_URL, SITE_URL } from "@/lib/site";

export const metadata: Metadata = {
  title: "Components — the drop-in kit for the whole lifecycle",
  description:
    "The in-app feed, bell, survey card and preference center are real @hogsend/react + @hogsend/js components. Email, Discord, Telegram and PostHog ride the same journeys and one identity.",
};

const SCAFFOLD_COMMAND = "pnpm dlx create-hogsend@latest my-app";

/** The wiring every in-app component reads from — one provider, one key. */
const INBOX_SRC = `import {
  HogsendProvider,
  NotificationBell,
  NotificationFeed,
} from "@hogsend/react";
import { PreferenceCenter } from "@hogsend/react/preferences";
import "@hogsend/react/styles.css";

// One provider, one publishable key — every component reads from it.
export function Inbox() {
  return (
    <HogsendProvider apiUrl={API_URL} publishableKey="pk_live_…">
      <NotificationBell onClick={toggle} />
      <NotificationFeed feedId="in_app" />
      <PreferenceCenter />
    </HogsendProvider>
  );
}`;

const JSON_LD = {
  "@context": "https://schema.org",
  "@type": "WebPage",
  name: "Components — the drop-in kit for the whole lifecycle",
  description:
    "Real @hogsend/react + @hogsend/js in-app components, plus email, Discord, Telegram and PostHog on the same journeys and one identity.",
  url: `${SITE_URL}/components`,
};

/**
 * Email is three looping clips. They live in a TabbedShowcase (one full-width
 * glass panel) rather than a half-width grid column: the JourneyTrace clips
 * switch to their wide side-by-side layout at the `lg` VIEWPORT breakpoint, so
 * they need a near-full-width container — a half column overflows them.
 */
const EMAIL_TABS = [
  {
    id: "answers",
    label: "In-email answers",
    title: "The click is the answer",
    description:
      "EmailAction renders a link whose click means something. A yes/no is two of them, an NPS is eleven — each answer fires a real event with its payload, and the journey branches on it. First click per send wins; scanner bursts are filtered before anything is recorded.",
    tags: ["NPS & yes/no", "Answer = event", "Scanner-safe"],
    media: (
      <Clip
        clip="semantic-links"
        title="An in-email question where the click is the answer"
      />
    ),
  },
  {
    id: "tracking",
    label: "Tracking",
    title: "Opens and clicks, first-party",
    description:
      "Every send is rewritten for first-party open and click tracking before it reaches your provider. Engagement flows back as email.opened / email.link_clicked — branch on it mid-journey, or fan it out to your destinations.",
    tags: ["Open tracking", "Click tracking", "First-party"],
    media: (
      <Clip
        clip="first-party-tracking"
        title="Link rewriting and open tracking, first-party"
      />
    ),
  },
  {
    id: "provider",
    label: "Your provider",
    title: "Send through your own account",
    description:
      "Email goes out through your own Resend or Postmark — your domain, your reputation, your costs. The provider is a dumb wire that takes HTML; swapping it is one env var, and the journey code never changes.",
    tags: ["Resend · Postmark", "Your domain", "Config, not code"],
    media: (
      <Clip
        clip="byo-provider"
        title="The engine hands rendered HTML to your own provider"
      />
    ),
  },
];

export default function ComponentsPage() {
  return (
    <main className="flex flex-1 flex-col">
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: static JSON-LD
        dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD) }}
      />

      {/* Header */}
      <Section divider={false} containerClassName="pt-32 pb-20">
        <AuroraBeam />
        <Reveal className="relative flex flex-col items-center text-center">
          <Eyebrow className="mb-5">Components</Eyebrow>
          <h1 className="max-w-3xl font-display font-medium text-5xl text-white leading-[1.02] tracking-[-0.05em] md:text-[64px]">
            The components, wired to your journeys
          </h1>
          <p className="mt-6 max-w-2xl text-base text-white/80 leading-7">
            The in-app feed, bell, survey card and preference center are real{" "}
            <code className="font-mono text-white/90">@hogsend/react</code> +{" "}
            <code className="font-mono text-white/90">@hogsend/js</code>{" "}
            components — drop them into your app. Email, Discord, Telegram and
            PostHog ride the same journeys and one identity. One theming surface
            across all of it.
          </p>
          <div className="mt-9 flex flex-wrap items-center justify-center gap-x-7 gap-y-4">
            <Button href="/docs/getting-started" variant="accent" icon>
              Start building
            </Button>
            <Button href="/docs/client-side" variant="outline">
              Client-side docs
            </Button>
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              className="text-sm text-white/60 tracking-[-0.02em] transition-colors hover:text-white"
            >
              View on GitHub →
            </a>
          </div>
        </Reveal>
      </Section>

      {/* In-app — the React/JS kit */}
      <Section>
        <Reveal>
          <SectionHeading
            eyebrow="In-app"
            title="Drop them into your app"
            subtitle={
              <>
                Knock-grade in-app messaging as React components, on a
                zero-dependency browser client. Every interaction is a
                first-party event your journeys trigger on —{" "}
                <code className="font-mono text-white/80">
                  inapp.item_clicked
                </code>
                ,{" "}
                <code className="font-mono text-white/80">
                  inapp.preference_changed
                </code>
                , a survey answer read by{" "}
                <code className="font-mono text-white/80">
                  ctx.waitForEvent
                </code>{" "}
                — not just analytics.
              </>
            }
          />
        </Reveal>

        <Reveal className="mt-12">
          <div className="grid items-center gap-8 lg:grid-cols-2 lg:gap-14">
            <div>
              <h3 className="font-medium text-2xl text-white leading-[1.2] tracking-[-0.02em]">
                One provider, then import what you need
              </h3>
              <p className="mt-4 max-w-xl text-base text-white/60 leading-7">
                The kit is the feed, the bell, the in-feed survey card and the
                preference center — plus a banner and a toast. Import the ones
                you need; a hooks-only import pulls no CSS. The bell ↗ in this
                nav is the same{" "}
                <code className="font-mono text-white/80">
                  NotificationBell
                </code>
                , live.
              </p>
            </div>
            <CodeWindow filename="app/inbox.tsx" code={INBOX_SRC} lang="tsx" />
          </div>
        </Reveal>

        {/* Live: fire a survey, answer it in the feed, watch the loop close.
            (Renders only where the engine + pk_ key are wired — prod.) */}
        <SurveyDemo
          codePanel={
            <CodeWindow
              filename="src/journeys/demo-survey.ts"
              code={SURVEY_SRC}
            />
          }
        />

        {/* Live: the real preference center reading the list catalog. */}
        <Reveal className="mt-4">
          <PreferenceCenterDemo />
        </Reveal>

        <Reveal className="mt-14">
          <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
            <FeatureCard
              icon={<Palette className="size-5" strokeWidth={1.5} />}
              title="Theme with tokens"
              description="Re-skin every component from one --hs-* block. No CVA, no Tailwind required — the whole kit reads CSS variables."
            />
            <FeatureCard
              icon={<SlidersHorizontal className="size-5" strokeWidth={1.5} />}
              title="Style any slot"
              description="Per-slot classNames and data-* state attributes on every element, so it matches your design system exactly."
            />
            <FeatureCard
              icon={<Code2 className="size-5" strokeWidth={1.5} />}
              title="Or replace it wholesale"
              description="renderItem, renderHeader and asChild hand you the markup. The closed-loop events still fire, so a custom UI can't opt out."
            />
          </div>
        </Reveal>
      </Section>

      {/* Email — three clips in a full-width tabbed panel (clips overflow a
          half-width column at the lg viewport, where they go side-by-side). */}
      <Section>
        <Reveal>
          <SectionHeading
            eyebrow="Email"
            title="Email that asks, and listens"
            subtitle="Templates are React components in your repo. The links inside are events, the opens and clicks are first-party, and the provider is your own."
          />
        </Reveal>

        <Reveal className="mt-12">
          <TabbedShowcase tabs={EMAIL_TABS} />
        </Reveal>

        <Reveal className="mt-12">
          <Link
            href="/emails"
            className="text-base text-white/80 tracking-[-0.02em] transition-colors hover:text-white"
          >
            Thirteen templates, already in your repo →
          </Link>
        </Reveal>
      </Section>

      {/* Discord & Telegram */}
      <Section>
        <Reveal>
          <SectionHeading
            eyebrow="Connectors"
            title="The channels they already live in"
            subtitle="Link a member's Discord or Telegram to their contact, and their activity there becomes a journey trigger — a reaction, a server join, a message — on the same identity as their email and product events."
          />
        </Reveal>

        <div className="mt-12 grid grid-cols-1 gap-6 md:grid-cols-2">
          <Reveal>
            <Card className="flex h-full flex-col gap-4">
              <span className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-white/[0.08] bg-white/[0.04] text-white">
                <MessageCircle className="size-5" strokeWidth={1.5} />
              </span>
              <h3 className="font-medium text-white text-xl leading-[1.2] tracking-[-0.02em]">
                Discord
              </h3>
              <p className="text-base text-white/60 leading-7">
                <code className="font-mono text-white/80">/link</code> confirms
                an email — folds a member's Discord and email onto one contact
                and grants the verified role. Reactions, joins and messages
                trigger journeys; a journey can grant roles and post back.
              </p>
              <Link
                href="/discord"
                className="mt-auto pt-1 text-sm text-white/80 tracking-[-0.02em] transition-colors hover:text-white"
              >
                Discord integration →
              </Link>
            </Card>
          </Reveal>

          <Reveal delay={0.08}>
            <Card className="flex h-full flex-col gap-4">
              <span className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-white/[0.08] bg-white/[0.04] text-white">
                <Send className="size-5" strokeWidth={1.5} />
              </span>
              <h3 className="font-medium text-white text-xl leading-[1.2] tracking-[-0.02em]">
                Telegram
              </h3>
              <p className="text-base text-white/60 leading-7">
                A{" "}
                <code className="font-mono text-white/80">
                  t.me/&lt;bot&gt;?start=
                </code>{" "}
                link or <code className="font-mono text-white/80">/link</code>{" "}
                binds Telegram to a contact. Messages trigger journeys, and a
                journey can reply in the same chat.
              </p>
              <Link
                href="/telegram"
                className="mt-auto pt-1 text-sm text-white/80 tracking-[-0.02em] transition-colors hover:text-white"
              >
                Telegram integration →
              </Link>
            </Card>
          </Reveal>
        </div>
      </Section>

      {/* PostHog */}
      <Section>
        <Reveal>
          <SectionHeading
            eyebrow="PostHog"
            title="PostHog, both directions"
            subtitle={
              <>
                <code className="font-mono text-white/80">
                  hogsend connect posthog
                </code>{" "}
                opens one browser consent. Person reads resolve timezones and
                property conditions; every email and lifecycle event fans back
                into PostHog as a captured event; and cross-channel ids —
                Discord, Telegram, email — fold into one person.
              </>
            }
          />
        </Reveal>

        <Reveal className="mt-12">
          <Clip
            clip="journey-posthog"
            title="A journey reads a PostHog person and fans events back in"
          />
        </Reveal>

        <Reveal className="mt-8">
          <Link
            href="/integrations"
            className="text-base text-white/80 tracking-[-0.02em] transition-colors hover:text-white"
          >
            Integrations →
          </Link>
        </Reveal>
      </Section>

      {/* Closing CTA */}
      <Section>
        <DotGrid />
        <Reveal className="relative flex flex-col items-center text-center">
          <Eyebrow className="mb-5">Get started</Eyebrow>
          <h2 className="max-w-2xl font-display text-[32px] text-white leading-[1.2] tracking-[-0.02em] md:text-[40px] md:leading-[48px]">
            Every component, one scaffold
          </h2>
          <p className="mt-5 max-w-xl text-base text-white/70 leading-7">
            The scaffold puts the components, the journeys, and the email
            templates in a repo you own — wired to one engine. Import the first
            component in your editor.
          </p>

          <div className="mt-10 flex w-full max-w-xl items-center justify-between gap-4 rounded-[10px] border border-white/10 bg-[#0a0606] px-4 py-3.5">
            <code className="overflow-x-auto whitespace-nowrap font-mono text-sm text-white/80">
              {SCAFFOLD_COMMAND}
            </code>
            <CopyButton value={SCAFFOLD_COMMAND} />
          </div>

          <div className="mt-8 flex flex-wrap items-center justify-center gap-x-7 gap-y-4">
            <Button href="/docs/getting-started" variant="accent" icon>
              Start building
            </Button>
            <Button href={RAILWAY_DEPLOY_URL} variant="outline" external>
              Deploy on Railway
            </Button>
            <Link
              href="/docs/client-side"
              className="text-sm text-white/60 tracking-[-0.02em] transition-colors hover:text-white"
            >
              or read the client-side docs →
            </Link>
          </div>

          <p className="eyebrow mt-8 text-white/40">
            Free to self-host · One scaffold command · No per-contact billing
          </p>
        </Reveal>
      </Section>
    </main>
  );
}
