import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { Eyebrow, PillBadge, TagPill } from "@/components/ds/badge";
import { Button } from "@/components/ds/button";
import { Card } from "@/components/ds/card";
import { CopyButton } from "@/components/ds/copy-button";
import { Reveal } from "@/components/ds/reveal";
import { Section } from "@/components/ds/section";
import { cn } from "@/lib/cn";
import { ENGINE_VERSION, GITHUB_URL, RAILWAY_DEPLOY_URL } from "@/lib/site";

// TODO: /changelog/rss.xml when entries move to MDX

export const metadata: Metadata = {
  title: "Changelog",
  description:
    "Every Hogsend release: features, fixes, and upgrade notes for the source-available lifecycle email engine. Upgrades are pnpm up, never a merge.",
};

const SCAFFOLD_COMMAND = "pnpm dlx create-hogsend@latest my-app";

function Code({ children }: { children: ReactNode }) {
  return (
    <code className="whitespace-nowrap rounded-[3px] border border-white/10 bg-white/[0.06] px-1.5 py-0.5 font-mono text-[0.85em] text-white/90">
      {children}
    </code>
  );
}

function Bullet({ children }: { children: ReactNode }) {
  return (
    <li className="flex gap-3 text-base text-white/70 leading-6">
      <span
        aria-hidden="true"
        className="mt-[9px] size-1.5 shrink-0 rounded-[1px] bg-accent/80"
      />
      <span>{children}</span>
    </li>
  );
}

type ChangelogEntry = {
  version: string;
  anchor: string;
  date: string;
  title: string;
  bullets: ReactNode;
  upgradeNote?: ReactNode;
};

/*
 * Facts verified against packages/engine/CHANGELOG.md and git tags
 * (dates are the real tag dates).
 */
const ENTRIES: ChangelogEntry[] = [
  {
    version: "0.16.0",
    anchor: "0-16-0",
    date: "June 11, 2026",
    title:
      "The where builder, the hosted answer page, and cross-device identity",
    bullets: (
      <>
        <Bullet>
          Journey conditions read like code:{" "}
          <Code>{'where: (b) => b.prop("score").lte(6)'}</Code> on{" "}
          <Code>trigger</Code> and <Code>exitOn</Code>, resolved once at
          definition time to the same plain data — Studio and the admin API are
          unchanged.
        </Bullet>
        <Bullet>
          Semantic links without a landing page:{" "}
          <Code>{"href={HOSTED_ANSWER_HREF}"}</Code> lands answers on an
          engine-hosted page with an optional comment box; comments arrive as{" "}
          <Code>{"<event>.comment"}</Code> events.
        </Bullet>
        <Bullet>
          Cross-device identity, opt-in: <Code>TRACKING_IDENTITY_TOKEN</Code>{" "}
          appends an encrypted one-hour <Code>hs_t</Code> token to tracked
          redirects; the landing site exchanges it at{" "}
          <Code>POST /v1/t/identify</Code> and calls{" "}
          <Code>posthog.identify</Code> — the email click and the web session
          become one person.
        </Bullet>
        <Bullet>
          <Code>ctx.waitForEvent</Code> accepts <Code>lookback</Code> to catch
          answers landing between two waits.
        </Bullet>
      </>
    ),
    upgradeNote: (
      <>
        Upgrade: <Code>{'pnpm up "@hogsend/*"'}</Code>. All three are additive;
        the identity token is off until you set{" "}
        <Code>TRACKING_IDENTITY_TOKEN=true</Code>.
      </>
    ),
  },
  {
    version: "0.14.0",
    anchor: "0-14-0",
    date: "June 11, 2026",
    title: "Semantic links — in-email surveys and one-tap actions",
    bullets: (
      <>
        <Bullet>
          <Code>{"<EmailAction>"}</Code> (new in <Code>@hogsend/email</Code>):
          an anchor whose click fires a real event — an NPS score, a yes/no —
          through the full ingest pipeline. The metadata is lifted into the
          tracked link at send time and never reaches the inbox.
        </Bullet>
        <Bullet>
          First answer per send wins, and confirmation is deferred past a
          30-second window so scanner click-bursts (Outlook SafeLinks,
          Proofpoint) are judged in full — including the scanner's first click —
          before anything is recorded.
        </Bullet>
        <Bullet>
          <Code>ctx.waitForEvent</Code> now returns the matched event's{" "}
          <Code>properties</Code>, so a journey branches on the answer directly;
          an optional <Code>lookback</Code> window closes the gap between
          back-to-back waits.
        </Bullet>
        <Bullet>
          New <Code>email.action</Code> outbound event — the PostHog preset
          captures it under your event name with the answer's properties
          flattened, ready for insights and cohorts.
        </Bullet>
      </>
    ),
    upgradeNote: (
      <>
        Upgrade: <Code>{'pnpm up "@hogsend/*"'}</Code> and run{" "}
        <Code>db:migrate</Code> (one additive migration on{" "}
        <Code>tracked_links</Code>). The scaffold ships a{" "}
        <Code>feedback-checkin</Code> example showing the whole loop.
      </>
    ),
  },
  {
    version: "0.11.0",
    anchor: "0-11-0",
    date: "June 9, 2026",
    title: "CLI-first Studio auth",
    bullets: (
      <>
        <Bullet>
          Public Studio sign-up is closed: there is no unauthenticated network
          path that creates a user.
        </Bullet>
        <Bullet>
          First admin via <Code>hogsend studio admin create</Code> (new CLI
          command, with <Code>reset</Code> and <Code>list</Code>) or env
          bootstrap (<Code>STUDIO_ADMIN_EMAIL</Code> /{" "}
          <Code>STUDIO_ADMIN_PASSWORD</Code>) on a zero-user database.
        </Bullet>
        <Bullet>
          Self-service password reset, wired through the engine mailer; tokens
          are single-use with a 15-minute TTL.
        </Bullet>
        <Bullet>
          Auth rate limiting is now shared across replicas via Redis.
        </Bullet>
      </>
    ),
    upgradeNote: (
      <>
        Upgrade: <Code>{'pnpm up "@hogsend/*"'}</Code>. If your Studio admin
        already exists, nothing changes; new deploys set{" "}
        <Code>STUDIO_ADMIN_EMAIL</Code> or run the CLI once.
      </>
    ),
  },
  {
    version: "0.10.0",
    anchor: "0-10-0",
    date: "June 8, 2026",
    title: "Bring your own email provider",
    bullets: (
      <>
        <Bullet>
          Provider-neutral <Code>EmailEvent</Code> webhook contract and an
          HTML-only send wire: the <Code>EmailProvider</Code> is now a dumb
          wire, and rendering, preferences, first-party tracking, and the send
          log stay engine-owned — so everything survives a provider swap.
        </Bullet>
        <Bullet>
          New opt-in <Code>@hogsend/plugin-postmark</Code>: swap with{" "}
          <Code>EMAIL_PROVIDER=postmark</Code>. Resend stays the default.
        </Bullet>
        <Bullet>
          Bounce normalization: auto-suppression now fires only on permanent
          bounces; transient bounces are recorded without suppressing.
        </Bullet>
        <Bullet>
          Provider-native open/click tracking is forced off where possible —
          first-party tracking is the source of truth.
        </Bullet>
      </>
    ),
    upgradeNote: (
      <>
        Upgrade: Postmark deploys need <Code>POSTMARK_SERVER_TOKEN</Code>
        {"; "}Resend deploys change nothing.
      </>
    ),
  },
  {
    version: "0.9.0",
    anchor: "0-9-0",
    date: "June 8, 2026",
    title: "Outbound destinations",
    bullets: (
      <>
        <Bullet>
          The durable outbound webhook spine becomes a fan-out engine:{" "}
          <Code>defineDestination()</Code> plus shipped presets for PostHog,
          Segment, and Slack alongside signed Standard-Webhooks.
        </Bullet>
        <Bullet>
          Every delivery reuses the same retry/backoff/dead-letter machinery.
        </Bullet>
        <Bullet>
          <Code>ENABLE_POSTHOG_DESTINATION</Code> auto-seeds a PostHog endpoint
          on the email funnel so the full lifecycle fans out durably.
        </Bullet>
        <Bullet>
          Breaking: <Code>ctx.posthog.capture</Code> and{" "}
          <Code>ctx.identify</Code> were removed from the journey context —
          PostHog is now one destination among many; the context keeps only
          vendor-neutral orchestration primitives.
        </Bullet>
      </>
    ),
    upgradeNote: (
      <>
        Upgrade note: open/click events now emit per hit (not first-touch only)
        — size webhook consumers accordingly.
      </>
    ),
  },
  {
    version: "0.8.0",
    anchor: "0-8-0",
    date: "June 7, 2026",
    title: "Outbound webhooks + inbound presets",
    bullets: (
      <>
        <Bullet>
          Signed outbound webhook stream: managed endpoints, per-endpoint
          retry/backoff, dead-letter queue, and a reaper that re-drives due
          retries.
        </Bullet>
        <Bullet>
          Inbound integration presets for Clerk, Supabase, Stripe, and Segment —
          set the secret env var and the signature-verified route auto-enables.
        </Bullet>
        <Bullet>
          <Code>hogsend webhooks</Code> CLI command and{" "}
          <Code>verifyHogsendWebhook</Code> in the client.
        </Bullet>
      </>
    ),
  },
  {
    version: "0.7.0",
    anchor: "0-7-0",
    date: "June 7, 2026",
    title: "The front door: Data API + client SDK",
    bullets: (
      <>
        <Bullet>
          Public <Code>/v1</Code> data plane: contacts, events, transactional
          emails, lists, and campaigns behind an <Code>hsk_</Code> API key.
        </Bullet>
        <Bullet>
          New <Code>@hogsend/client</Code> typed SDK over the data plane.
        </Bullet>
        <Bullet>
          Identity gains email/anonymous keys with a real merge/alias resolver.
        </Bullet>
        <Bullet>
          Lists are code-defined over the preference store; campaigns are
          durable, idempotent, preference-checked broadcasts.
        </Bullet>
      </>
    ),
  },
];

function ChangelogHeader() {
  return (
    <Section divider={false} containerClassName="pt-32 pb-20">
      <Reveal>
        <div className="flex max-w-3xl flex-col items-start">
          <PillBadge>
            <span
              aria-hidden="true"
              className="size-1.5 rounded-full bg-accent"
            />
            Latest release: v{ENGINE_VERSION}
          </PillBadge>
          <h1 className="mt-6 font-display font-medium text-5xl text-white leading-[1.05] tracking-[-0.05em] md:text-[64px]">
            Changelog
          </h1>
          <p className="mt-6 max-w-xl text-base text-white/70 leading-6">
            Every release of the engine, CLI, Studio, and providers. Upgrading
            is <Code>{'pnpm up "@hogsend/*"'}</Code> — never a fork merge.
          </p>
        </div>
      </Reveal>
    </Section>
  );
}

function Entry({ entry, first }: { entry: ChangelogEntry; first: boolean }) {
  return (
    <article
      id={entry.anchor}
      className={cn(
        "grid scroll-mt-[calc(7rem+var(--fd-banner-height,0px))] gap-5 py-12 md:grid-cols-[200px_minmax(0,1fr)] md:gap-12",
        first && "pt-0",
      )}
    >
      <div className="flex flex-row items-center gap-4 self-start md:sticky md:top-28 md:flex-col md:items-start md:gap-3">
        <a
          href={`#${entry.anchor}`}
          className="transition-opacity hover:opacity-80"
        >
          <TagPill accent className="font-mono">
            v{entry.version}
          </TagPill>
        </a>
        <time className="text-sm text-white/40">{entry.date}</time>
      </div>

      <div>
        <h2 className="font-medium text-white text-xl leading-7 tracking-[-0.02em] md:text-2xl md:leading-8">
          {entry.title}
        </h2>
        <ul className="mt-5 flex flex-col gap-3">{entry.bullets}</ul>
        {entry.upgradeNote ? (
          <p className="mt-6 text-sm text-white/50 italic leading-6">
            {entry.upgradeNote}
          </p>
        ) : null}
      </div>
    </article>
  );
}

function Entries() {
  return (
    <Section>
      <div className="divide-y divide-hairline-faint">
        {ENTRIES.map((entry, i) => (
          <Reveal key={entry.version} delay={(i % 3) * 0.08}>
            <Entry entry={entry} first={i === 0} />
          </Reveal>
        ))}
      </div>

      <div className="flex flex-wrap gap-x-10 gap-y-3 border-hairline-faint border-t pt-10">
        <Link
          href="/docs/operating/upgrading"
          className="text-base text-white transition-colors hover:text-white/80"
        >
          Upgrading guide →
        </Link>
        <a
          href={`${GITHUB_URL}/releases`}
          target="_blank"
          rel="noreferrer"
          className="text-base text-white transition-colors hover:text-white/80"
        >
          Full release notes on GitHub →
        </a>
      </div>
    </Section>
  );
}

function ClosingCta() {
  return (
    <Section>
      <Reveal>
        <Card className="relative overflow-hidden p-8 md:p-14">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                "radial-gradient(70% 120% at 0% 60%, rgba(246, 72, 56, 0.22), transparent 70%)",
            }}
          />

          <div className="relative flex max-w-2xl flex-col items-start">
            <Eyebrow>Stay on the line</Eyebrow>
            <h2 className="mt-4 font-display text-[32px] text-white leading-[1.2] tracking-[-0.02em] md:text-[40px] md:leading-[48px]">
              Start on the latest release
            </h2>
            <p className="mt-5 text-base text-white/70 leading-6">
              One scaffold command pulls v{ENGINE_VERSION}; one{" "}
              <Code>pnpm up</Code> keeps you current. Your journeys live in your
              repo, so an upgrade is a dependency bump — never a fork merge.
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-4">
              <Button href="/docs/getting-started" icon>
                Start building
              </Button>
              <Button href={RAILWAY_DEPLOY_URL} variant="outline" external>
                Deploy on Railway
              </Button>
              <Link
                href="/docs"
                className="text-sm text-white/60 transition-colors hover:text-white"
              >
                or read the docs first →
              </Link>
            </div>

            <p className="eyebrow mt-6 text-white/40">
              Free to self-host · One scaffold command · No per-contact billing
            </p>

            <div className="mt-8 flex w-full max-w-md items-center justify-between gap-4 rounded-[10px] border border-white/10 bg-[#0a0606] px-4 py-3">
              <code className="overflow-x-auto whitespace-nowrap font-mono text-sm text-white/80">
                {SCAFFOLD_COMMAND}
              </code>
              <CopyButton value={SCAFFOLD_COMMAND} />
            </div>
          </div>
        </Card>
      </Reveal>
    </Section>
  );
}

export default function ChangelogPage() {
  return (
    <main className="flex flex-1 flex-col">
      <ChangelogHeader />
      <Entries />
      <ClosingCta />
    </main>
  );
}
