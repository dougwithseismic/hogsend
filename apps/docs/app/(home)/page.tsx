import { highlight } from "fumadocs-core/highlight";
import {
  ArrowRight,
  BarChart3,
  Boxes,
  Clock,
  CreditCard,
  GitBranch,
  Mail,
  Workflow,
} from "lucide-react";
import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import lifecycleImg from "@/public/images/hogsend-lifecycle.png";
import studioJourneys from "@/public/images/studio/studio-journeys.png";
import studioOverview from "@/public/images/studio/studio-overview.png";
import studioSends from "@/public/images/studio/studio-sends.png";
import studioTemplates from "@/public/images/studio/studio-templates.png";

function GithubMark({ className }: { className?: string }) {
  return (
    <svg
      role="img"
      aria-label="GitHub"
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
    >
      <path d="M12 .5C5.37.5 0 5.78 0 12.29c0 5.2 3.44 9.61 8.21 11.17.6.11.82-.25.82-.56 0-.28-.01-1.02-.02-2-3.34.71-4.04-1.58-4.04-1.58-.55-1.36-1.33-1.73-1.33-1.73-1.09-.73.08-.72.08-.72 1.2.08 1.84 1.21 1.84 1.21 1.07 1.8 2.81 1.28 3.5.98.11-.76.42-1.28.76-1.58-2.67-.3-5.47-1.31-5.47-5.83 0-1.29.47-2.34 1.24-3.17-.12-.3-.54-1.52.12-3.16 0 0 1.01-.32 3.3 1.21a11.5 11.5 0 0 1 6 0c2.29-1.53 3.3-1.21 3.3-1.21.66 1.64.24 2.86.12 3.16.77.83 1.23 1.88 1.23 3.17 0 4.53-2.81 5.53-5.49 5.82.43.36.81 1.08.81 2.18 0 1.57-.01 2.84-.01 3.23 0 .31.22.68.83.56C20.56 21.9 24 17.49 24 12.29 24 5.78 18.63.5 12 .5Z" />
    </svg>
  );
}

export const metadata: Metadata = {
  title: "Hogsend — code-first lifecycle email for PostHog + Resend",
  description:
    "The lifecycle email automation that PostHog teams actually need. Journeys and buckets as plain TypeScript functions — not YAML, not a drag-and-drop canvas. Self-hosted, open source.",
};

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col">
      <Hero />
      <StackStrip />
      <Primitives />
      <WhatYouCanBuild />
      <HowItWorks />
      <Studio />
      <GetStarted />
    </main>
  );
}

/* -------------------------------------------------------------------------- */

function Hero() {
  return (
    <section className="relative overflow-hidden border-b border-fd-border">
      <div
        aria-hidden
        className="-z-10 pointer-events-none absolute inset-0 bg-[radial-gradient(60%_60%_at_50%_0%,var(--color-fd-primary)/8%,transparent_70%)]"
      />
      <div className="mx-auto flex max-w-5xl flex-col items-center px-4 py-20 text-center md:py-28">
        <span className="mb-5 inline-flex items-center gap-2 rounded-full border border-fd-border bg-fd-card px-3 py-1 text-fd-muted-foreground text-xs">
          <span className="size-1.5 rounded-full bg-green-500" />
          Open source · self-hosted · yours to run
        </span>

        <h1 className="max-w-3xl text-balance font-bold text-4xl tracking-tight md:text-6xl">
          The right email at exactly{" "}
          <span className="text-fd-muted-foreground">the right moment</span>
        </h1>

        <p className="mt-6 max-w-2xl text-balance text-fd-muted-foreground text-lg leading-relaxed">
          PostHog already knows what your users do. Resend already sends your
          mail. Hogsend is the piece that connects them — so when someone signs
          up, hits a milestone, or goes quiet, the right message goes out on its
          own. No new platform to learn, no drag-and-drop builder to wrestle.
        </p>

        <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row">
          <Link
            href="/docs"
            className="inline-flex items-center gap-2 rounded-lg bg-fd-primary px-5 py-2.5 font-medium text-fd-primary-foreground text-sm transition-opacity hover:opacity-90"
          >
            Get started
            <ArrowRight className="size-4" />
          </Link>
          <a
            href="https://github.com/dougwithseismic/hogsend"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 rounded-lg border border-fd-border bg-fd-card px-5 py-2.5 font-medium text-sm transition-colors hover:bg-fd-accent"
          >
            <GithubMark className="size-4" />
            Star on GitHub
          </a>
        </div>

        <div className="mt-8 inline-flex items-center gap-3 rounded-lg border border-fd-border bg-fd-card px-4 py-2.5 font-mono text-sm">
          <span className="select-none text-fd-muted-foreground">$</span>
          <span>pnpm dlx create-hogsend@latest my-app</span>
        </div>
      </div>
    </section>
  );
}

function StackStrip() {
  const tools = ["PostHog", "Resend", "Railway", "Docker"];
  return (
    <section className="border-b border-fd-border bg-fd-card/30">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-center gap-x-8 gap-y-3 px-4 py-6">
        <span className="text-fd-muted-foreground text-xs uppercase tracking-wider">
          Works with
        </span>
        {tools.map((t) => (
          <span
            key={t}
            className="font-medium text-fd-muted-foreground text-sm"
          >
            {t}
          </span>
        ))}
      </div>
    </section>
  );
}

function Primitives() {
  return (
    <section className="border-b border-fd-border">
      <div className="mx-auto max-w-6xl px-4 py-20 md:py-24">
        <SectionHeading
          eyebrow="The two building blocks"
          title="Journeys and buckets, working together"
          subtitle="Journeys are emails that play out over time. Buckets are live groups of people — your power users, trials about to lapse, anyone who's drifted away. The moment someone joins a bucket, it can start a journey for them."
        />

        <div className="mt-12 grid items-start gap-6 lg:grid-cols-2">
          <PrimitiveCard
            icon={<Workflow className="size-5" />}
            kind="Journeys"
            blurb="Email sequences that wait, branch, and stop on their own. 'Send a welcome, wait two days, then nudge anyone who hasn't tried it' takes just a few lines."
            filename="journeys/activation-welcome.ts"
            code={JOURNEY_CODE}
          />
          <PrimitiveCard
            icon={<Boxes className="size-5" />}
            kind="Buckets"
            blurb="Live groups that update the instant someone qualifies — no overnight wait. When people join or leave, it can kick off a journey automatically."
            filename="buckets/went-dormant.ts"
            code={BUCKET_CODE}
          />
        </div>
      </div>
    </section>
  );
}

function WhatYouCanBuild() {
  const items = [
    {
      icon: <Mail className="size-5" />,
      title: "Welcome new users",
      body: "Greet people when they sign up, then follow up differently depending on whether they've actually tried things.",
    },
    {
      icon: <CreditCard className="size-5" />,
      title: "Turn trials into customers",
      body: "Nudge trials toward paying, with the message matched to how much they've really used.",
    },
    {
      icon: <Clock className="size-5" />,
      title: "Recover failed payments",
      body: "Send friendly reminders when a payment fails — that stop the instant it goes through.",
    },
    {
      icon: <Boxes className="size-5" />,
      title: "Catch the right moment",
      body: "Spot your power users — or anyone slipping away — the moment it happens, and act on it.",
    },
    {
      icon: <GitBranch className="size-5" />,
      title: "One thing leads to another",
      body: "Let one sequence hand off to the next, so flows build on each other instead of repeating.",
    },
    {
      icon: <BarChart3 className="size-5" />,
      title: "Win back quiet users",
      body: "Notice when someone goes quiet, run a win-back series, and see who comes back.",
    },
  ];
  return (
    <section className="border-b border-fd-border bg-fd-card/30">
      <div className="mx-auto max-w-6xl px-4 py-20 md:py-24">
        <SectionHeading
          eyebrow="What you can build"
          title="The emails every product should send"
          subtitle="Welcome series, trial nudges, win-backs, payment saves — the flows every product needs. Ten of them ship ready to edit, not blank pages."
        />
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((it) => (
            <div
              key={it.title}
              className="rounded-xl border border-fd-border bg-fd-card p-5"
            >
              <div className="mb-3 flex size-9 items-center justify-center rounded-lg bg-fd-accent text-fd-foreground">
                {it.icon}
              </div>
              <h3 className="font-semibold text-sm">{it.title}</h3>
              <p className="mt-1.5 text-fd-muted-foreground text-sm leading-relaxed">
                {it.body}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function HowItWorks() {
  return (
    <section className="border-b border-fd-border">
      <div className="mx-auto max-w-5xl px-4 py-20 text-center md:py-24">
        <SectionHeading
          eyebrow="How it works"
          title="One loop, not another platform"
          subtitle="Activity comes in from PostHog, the right emails go out through Resend, and what people do with them flows right back. Nothing new to buy or keep in sync."
        />
        <div className="mt-12 overflow-hidden rounded-xl border border-fd-border bg-fd-card p-2">
          <Image
            src={lifecycleImg}
            alt="PostHog → Hogsend → Resend lifecycle email flow"
            className="h-auto w-full rounded-lg"
            sizes="(max-width: 1024px) 100vw, 1024px"
            placeholder="blur"
          />
        </div>
      </div>
    </section>
  );
}

function Studio() {
  return (
    <section className="border-b border-fd-border bg-fd-card/30">
      <div className="mx-auto max-w-6xl px-4 py-20 md:py-24">
        <SectionHeading
          eyebrow="Studio"
          title="See everything that goes out"
          subtitle="A clean dashboard for every email, journey, and contact. Watch what's happening, preview a template, resend a failed message, or pause a sequence — no digging through logs."
        />
        <div className="mt-12 grid gap-4 md:grid-cols-2">
          {[
            { img: studioOverview, label: "Overview" },
            { img: studioJourneys, label: "Journeys" },
            { img: studioSends, label: "Sends" },
            { img: studioTemplates, label: "Templates" },
          ].map((s) => (
            <figure
              key={s.label}
              className="overflow-hidden rounded-xl border border-fd-border bg-fd-card"
            >
              <Image
                src={s.img}
                alt={`Hogsend Studio — ${s.label}`}
                className="h-auto w-full"
                sizes="(max-width: 768px) 100vw, 50vw"
                placeholder="blur"
              />
              <figcaption className="border-fd-border border-t px-4 py-2 text-fd-muted-foreground text-xs">
                {s.label}
              </figcaption>
            </figure>
          ))}
        </div>
      </div>
    </section>
  );
}

async function GetStarted() {
  return (
    <section>
      <div className="mx-auto max-w-3xl px-4 py-20 text-center md:py-28">
        <h2 className="text-balance font-bold text-3xl tracking-tight md:text-4xl">
          Live in days, not a migration
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-balance text-fd-muted-foreground leading-relaxed">
          One command sets up a starter app that's yours to edit. Host it
          yourself with Docker, or launch it on Railway in a single click.
        </p>

        <div className="mx-auto mt-8 max-w-md rounded-xl border border-fd-border bg-fd-card p-1 text-left">
          <Code
            code={INSTALL_CODE}
            lang="bash"
            className="py-3 font-mono text-sm leading-relaxed"
          />
        </div>

        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link
            href="/docs/getting-started"
            className="inline-flex items-center gap-2 rounded-lg bg-fd-primary px-5 py-2.5 font-medium text-fd-primary-foreground text-sm transition-opacity hover:opacity-90"
          >
            Read the docs
            <ArrowRight className="size-4" />
          </Link>
          <a
            href="https://railway.com/deploy/LxSCyR"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="https://railway.com/button.svg"
              alt="Deploy on Railway"
              className="h-[42px]"
            />
          </a>
        </div>
      </div>
    </section>
  );
}

/* ---------------------------------- bits --------------------------------- */

// Server-side Shiki highlighting (github-light/dark dual theme), reusing the
// same `.shiki` CSS variables that fumadocs-ui/css/preset.css already wires up.
// The pre background is forced transparent so the code blends into our cards.
async function Code({
  code,
  lang,
  className,
}: {
  code: string;
  lang: string;
  className?: string;
}) {
  return highlight(code, {
    lang,
    components: {
      pre: ({ className: shikiClass, style, ...props }) => (
        <pre
          {...props}
          style={{ ...style, backgroundColor: "transparent" }}
          className={`${shikiClass ?? ""} overflow-x-auto ${className ?? ""}`}
        />
      ),
    },
  });
}

function SectionHeading({
  eyebrow,
  title,
  subtitle,
}: {
  eyebrow: string;
  title: string;
  subtitle: string;
}) {
  return (
    <div className="mx-auto max-w-2xl text-center">
      <p className="font-medium text-fd-muted-foreground text-xs uppercase tracking-wider">
        {eyebrow}
      </p>
      <h2 className="mt-3 text-balance font-bold text-3xl tracking-tight md:text-4xl">
        {title}
      </h2>
      <p className="mt-4 text-balance text-fd-muted-foreground leading-relaxed">
        {subtitle}
      </p>
    </div>
  );
}

async function PrimitiveCard({
  icon,
  kind,
  blurb,
  filename,
  code,
}: {
  icon: React.ReactNode;
  kind: string;
  blurb: string;
  filename: string;
  code: string;
}) {
  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-fd-border bg-fd-card">
      <div className="p-6">
        <div className="flex items-center gap-2.5">
          <span className="flex size-9 items-center justify-center rounded-lg bg-fd-accent text-fd-foreground">
            {icon}
          </span>
          <h3 className="font-semibold text-lg">{kind}</h3>
        </div>
        <p className="mt-3 text-fd-muted-foreground text-sm leading-relaxed">
          {blurb}
        </p>
      </div>
      <div className="border-fd-border border-t bg-fd-background/60">
        <div className="flex items-center gap-1.5 border-fd-border border-b px-4 py-2">
          <span className="size-2.5 rounded-full bg-fd-border" />
          <span className="size-2.5 rounded-full bg-fd-border" />
          <span className="size-2.5 rounded-full bg-fd-border" />
          <span className="ml-2 font-mono text-fd-muted-foreground text-xs">
            {filename}
          </span>
        </div>
        <Code
          code={code}
          lang="ts"
          className="py-4 font-mono text-[13px] leading-relaxed"
        />
      </div>
    </div>
  );
}

/* --------------------------------- code ---------------------------------- */

const JOURNEY_CODE = `export const welcome = defineJourney({
  meta: {
    id: "activation-welcome",
    trigger: { event: "user_signed_up" },
    entryLimit: "once",
  },
  run: async (user, ctx) => {
    await sendEmail({ to: user.email, template: "welcome" });

    await ctx.sleep({ duration: days(2) });

    const { found } = await ctx.history.hasEvent({
      userId: user.id,
      event: "feature_used",
    });
    if (!found) {
      await sendEmail({ to: user.email, template: "nudge" });
    }
  },
});`;

const BUCKET_CODE = `export const wentDormant = defineBucket({
  meta: {
    id: "went-dormant",
    enabled: true,
    timeBased: true,
    criteria: (b) =>
      b.all(
        // active at some point...
        b.event("app.active").exists(),
        // ...but not in the last 7 days
        b.event("app.active").within(days(7)).notExists(),
      ),
  },
});`;

const INSTALL_CODE = `pnpm dlx create-hogsend@latest my-app
cd my-app

pnpm bootstrap         # Docker + .env + Hatchet token + migrate
pnpm dev               # API on :3002`;
