import { Mail, MessageSquare, Zap } from "lucide-react";
import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import type { JSX, ReactNode } from "react";
import { TrackDemoClick } from "@/components/analytics/track";
import { AnnouncementBanner } from "@/components/announcement-banner";
import { CookieSettingsLink } from "@/components/consent/cookie-settings-link";
import { type BrandKey, BrandLogo } from "@/components/ds/brand-logo";
import { CodeHighlight } from "@/components/ds/code-highlight";
import { CopyButton } from "@/components/ds/copy-button";
import { LogoMarquee } from "@/components/ds/marquee";
import { Reveal } from "@/components/ds/reveal";
import { isHogsendConfigured } from "@/components/hogsend/config";
import { InAppDemoBody } from "@/components/landing/in-app-demo-body";
import { cn } from "@/lib/cn";
import { getEngineVersion } from "@/lib/engine-version";
import { DEMO_URL, GITHUB_URL, NPM_URL, RAILWAY_DEPLOY_URL } from "@/lib/site";
import postphant from "@/public/images/postphant.png";
import studioOverview from "@/public/images/studio/02-overview-dashboard.png";
import studioSends from "@/public/images/studio/04-sends-history.png";
import studioJourneys from "@/public/images/studio/08-journeys-overview.png";
import { AgentPromptLoop } from "./_components/agent-prompt-loop";
import { PsBlocksTabs } from "./_components/blocks-tabs";
import { InkLogo } from "./_components/brand";
import {
  type ProviderValue,
  PsCodePicker,
  type UseCaseValue,
} from "./_components/code-picker";
import { HeroItem, HeroReveal } from "./_components/hero-reveal";
import { PsNav } from "./_components/nav";
import { WordReveal } from "./_components/word-reveal";

/* ========================================================================== */
/*  The Hogsend homepage — spike-polar layout, dark crimzon scheme.           */
/*                                                                            */
/*  Layout/typography developed as the /spike-polar spike (a light Polar      */
/*  Signals design-system exploration), promoted to the homepage 2026-07-02   */
/*  and re-set on the crimzon ground: #050101 ink page, #F64838 accent,       */
/*  white text ramp (white → /75 body → /55 muted → /40 faint), white/10      */
/*  hairlines, red-tint section rules + page frame, white-fill primary        */
/*  buttons (the crimzon ds/button idiom).                                    */
/*  Kept from the spike: Montserrat display (--ps-display), ▲ mono eyebrows,  */
/*  huge sentence-case display h2s ending in a period, two-tone headlines     */
/*  (white → faint), contour-line/dot-grid decorations, ink glow panels,      */
/*  black 4-column footer, radius 6px.                                        */
/*                                                                            */
/*  All copy is the real homepage copy — nothing invented, no usage claims.   */
/* ========================================================================== */

export const metadata: Metadata = {
  title: {
    absolute: "Hogsend — Lifecycle automation in TypeScript",
  },
  description:
    "Lifecycle automation in TypeScript for product-led teams. Build onboarding, conversion, retention, and win-back journeys in your repo — with or without PostHog.",
  alternates: { canonical: "/" },
  keywords: [
    "lifecycle automation framework",
    "product-led growth",
    "customer lifecycle",
    "typescript",
    "code-first",
    "agent-native",
    "posthog",
    "email automation",
    "self-hosted",
  ],
};

const DISPLAY = "[font-family:var(--ps-display)]";
const INSTALL_COMMAND = "pnpm dlx create-hogsend@latest my-app";

/* ---------------------------------------------------------------- atoms -- */

function Container({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn("mx-auto w-full max-w-[1256px] px-6 md:px-10", className)}
    >
      {children}
    </div>
  );
}

function Eyebrow({
  children,
  light,
  className,
}: {
  children: ReactNode;
  light?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 font-mono text-[12px] uppercase tracking-[0.08em]",
        light ? "text-white/80" : "text-white",
        className,
      )}
    >
      <svg
        width="9"
        height="8"
        viewBox="0 0 9 8"
        aria-hidden="true"
        className="text-[#f64838]"
      >
        <path d="M4.5 0L9 8H0z" fill="currentColor" />
      </svg>
      {children}
    </span>
  );
}

function Btn({
  href,
  variant = "solid",
  size = "sm",
  newTab,
  children,
  className,
}: {
  href: string;
  variant?: "solid" | "outline" | "ghost";
  size?: "sm" | "lg";
  newTab?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Link
      href={href}
      target={newTab ? "_blank" : undefined}
      rel={newTab ? "noreferrer" : undefined}
      className={cn(
        "inline-flex items-center justify-center rounded-[6px] font-medium tracking-[-0.025em] transition-colors",
        size === "sm" ? "px-4 py-2 text-sm" : "px-5 py-3.5 text-base",
        variant === "solid" && "bg-white text-[#0a0a0a] hover:bg-white/90",
        variant === "outline" &&
          "border border-white/25 text-white hover:bg-white/[0.06]",
        variant === "ghost" && "text-white hover:opacity-70",
        className,
      )}
    >
      {children}
    </Link>
  );
}

/* ----------------------------------------------------------- decorations -- */

/** Fanned contour lines with a slow dash-drift — the abstract "ad-lib"
 * layer, drawn in code so it stays on-palette. */
function WaveLines({
  className,
  stroke = "rgba(255,150,128,0.45)",
  count = 7,
}: {
  className?: string;
  stroke?: string;
  count?: number;
}) {
  const paths = Array.from({ length: count }, (_, i) => {
    const y = 16 + i * 26;
    const lift = 24 + ((i * 13) % 26);
    return `M-20 ${y} C 180 ${y - lift}, 380 ${y + lift}, 620 ${y - lift / 2} S 980 ${y + lift}, 1240 ${y - lift}`;
  });
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 1200 200"
      fill="none"
      preserveAspectRatio="none"
      className={cn("pointer-events-none", className)}
    >
      {paths.map((d, i) => (
        <path
          // biome-ignore lint/suspicious/noArrayIndexKey: static deterministic art
          key={i}
          d={d}
          stroke={stroke}
          strokeWidth="1"
          strokeOpacity={0.3 + (i % 4) * 0.16}
          className="ps-dash"
          style={{ animationDelay: `${i * -3.5}s` }}
        />
      ))}
    </svg>
  );
}

/** Repeating plus-sign pattern (SVG data-URI), crimzon at low alpha. */
function PlusGrid({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn("pointer-events-none absolute", className)}
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml,%3Csvg width='28' height='28' viewBox='0 0 28 28' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M14 10v8M10 14h8' stroke='%23f64838' stroke-opacity='0.25' stroke-width='1'/%3E%3C/svg%3E\")",
        backgroundSize: "28px 28px",
      }}
    />
  );
}

/** Purple dot-grid blocks (the ASCII-ish pixel decorations). */
function DotPatch({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn("pointer-events-none absolute", className)}
      style={{
        backgroundImage:
          "radial-gradient(rgba(246,72,56,0.4) 1.2px, transparent 1.2px)",
        backgroundSize: "9px 9px",
      }}
    />
  );
}

/* ----------------------------------------------------------------- hero -- */

/** The hero live-demo window. With an engine wired (isHogsendConfigured) it
 * hosts the REAL demo — `InAppDemoBody`: a real sign-up that starts the
 * dogfood welcome series, the live in-app feed it unlocks, and the journey
 * trace band. Without one (a build missing the NEXT_PUBLIC vars) it falls
 * back to the animated sketch so the page still renders everywhere. */
function PsHeroDemo() {
  return (
    <div className="mx-auto max-w-[1024px] overflow-hidden rounded-xl border border-white/15 bg-[#0a0606] shadow-2xl">
      {/* Window chrome */}
      <div className="flex items-center justify-between border-white/10 border-b px-4 py-2.5">
        <div className="flex items-center gap-3">
          <div aria-hidden="true" className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-full bg-white/15" />
            <span className="size-2.5 rounded-full bg-white/15" />
            <span className="size-2.5 rounded-full bg-white/15" />
          </div>
          <span className="font-mono text-white/40 text-[11px] tracking-wide">
            hogsend.com — live demo
          </span>
        </div>
        <span className="flex items-center gap-1.5 font-mono text-[#23c489] text-[11px]">
          <span className="ps-pulse size-1.5 rounded-full bg-[#23c489]" />
          {isHogsendConfigured ? "live" : "sketch"}
        </span>
      </div>
      {isHogsendConfigured ? (
        <div className="p-4 text-left md:p-6">
          <InAppDemoBody />
        </div>
      ) : (
        <HeroDemoSketch />
      )}
    </div>
  );
}

/** The no-engine fallback: the sign-up + feed loop as a pure-CSS sketch on a
 * shared 10s clock — the email types itself, feed cards arrive staggered. */
function HeroDemoSketch() {
  const feed = [
    {
      icon: <Mail className="size-3.5" strokeWidth={1.5} />,
      title: "Welcome to Hogsend 👋",
      body: "A real welcome series just left hello@hogsend.com.",
      journey: "activation-welcome",
      time: "just now",
      delay: 2.2,
    },
    {
      icon: <Zap className="size-3.5" strokeWidth={1.5} />,
      title: "You fired demo.milestone",
      body: "A journey caught it and dropped this notification.",
      journey: "retention-milestone",
      time: "2m",
      delay: 4.6,
    },
  ];
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 md:divide-x md:divide-white/10">
      {/* Left — the real sign-up, typing itself. */}
      <div className="p-6 text-left md:p-8">
        <span className="font-mono text-white/40 text-[11px] uppercase tracking-[0.08em]">
          Get the demo
        </span>
        <h3 className="mt-3 font-medium text-white text-xl tracking-[-0.02em]">
          First name, email — get the demo.
        </h3>
        <p className="mt-2 text-white/55 text-sm leading-[21px] tracking-[-0.02em]">
          A stock create-hogsend app running in production ingests the event,
          runs its welcome journey, and sends from hello@hogsend.com a few
          seconds later.
        </p>
        <div className="mt-6 flex items-center gap-2 rounded-[6px] border border-white/10 p-1.5 pl-4">
          <span className="flex-1 font-mono text-white/75 text-sm">
            <span className="ps-type">sam@acme.com</span>
            <span
              aria-hidden="true"
              className="ps-caret -mb-0.5 inline-block h-4 w-px bg-[#f64838]"
            />
          </span>
          <span className="rounded-[4px] bg-white px-3.5 py-2 font-medium text-[#0a0a0a] text-sm">
            Get the demo
          </span>
        </div>
        <p className="mt-4 text-white/40 text-[12px] leading-5 tracking-[-0.02em]">
          Same engine, same journey code you scaffold · unsubscribe is one click
        </p>
      </div>

      {/* Right — the in-app loop, notifications arriving live. */}
      <div className="bg-white/[0.04] p-6 text-left md:p-8">
        <div className="flex items-center justify-between">
          <span className="font-mono text-white/40 text-[11px] uppercase tracking-[0.08em]">
            Live feed
          </span>
          <span className="flex items-center gap-1.5 font-mono text-[#23c489] text-[11px]">
            <span className="ps-pulse size-1.5 rounded-full bg-[#23c489]" />
            connected
          </span>
        </div>
        <div className="mt-4 flex flex-col gap-2.5">
          {feed.map((n) => (
            <div
              key={n.title}
              className="ps-feed-in rounded-md border border-white/10 bg-white/[0.04] px-4 py-3"
              style={{ animationDelay: `${n.delay}s` }}
            >
              <div className="flex items-start gap-3">
                <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-[6px] bg-[#f64838]/[0.12] text-[#f64838]">
                  {n.icon}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate font-medium text-white text-[13px] tracking-[-0.02em]">
                      {n.title}
                    </p>
                    <span className="flex shrink-0 items-center gap-2">
                      <span className="text-white/40 text-[11px]">
                        {n.time}
                      </span>
                      <span className="size-1.5 rounded-full bg-[#f64838]" />
                    </span>
                  </div>
                  <p className="mt-0.5 text-white/55 text-[12px] leading-5 tracking-[-0.02em]">
                    {n.body}
                  </p>
                  <p className="mt-1.5 font-mono text-white/40 text-[10px]">
                    via {n.journey}
                  </p>
                </div>
              </div>
            </div>
          ))}
          {/* The in-email answer — the click IS the answer. */}
          <div
            className="ps-feed-in rounded-md border border-white/10 bg-white/[0.04] px-4 py-3"
            style={{ animationDelay: "7s" }}
          >
            <div className="flex items-start gap-3">
              <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-[6px] bg-[#f64838]/[0.12] text-[#f64838]">
                <MessageSquare className="size-3.5" strokeWidth={1.5} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-medium text-white text-[13px] tracking-[-0.02em]">
                  Quick question
                </p>
                <p className="mt-0.5 text-white/55 text-[12px] leading-5 tracking-[-0.02em]">
                  How likely are you to recommend Hogsend? The click is the
                  answer — the journey branches on it.
                </p>
                <div className="mt-2.5 flex items-center gap-2">
                  <span className="rounded-full bg-[#f64838]/[0.08] px-3 py-1 font-medium text-[#f64838] text-[12px]">
                    Likely
                  </span>
                  <span className="rounded-full border border-white/10 px-3 py-1 font-medium text-white/55 text-[12px]">
                    Not yet
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function PsHero({ engineVersion }: { engineVersion?: string }) {
  return (
    <section className="relative overflow-hidden">
      <Container className="relative flex min-h-[46vh] flex-col items-center pt-14 text-center md:min-h-[60vh] md:pt-24">
        <HeroReveal className="flex w-full flex-col items-center">
          <HeroItem>
            <a
              href="https://course.hogsend.com"
              aria-label="New course — Measure, Keep, Grow — now live"
              className="inline-flex items-center gap-2 rounded-full bg-[#f64838]/[0.08] py-1 pr-3 pl-1 text-[12px] text-white sm:text-[13px]"
            >
              <span className="rounded-full bg-[#f64838] px-2.5 py-0.5 font-medium text-white">
                New Course
              </span>
              <span className="font-medium">Measure → Keep → Grow</span>
              <span className="text-white/45">· Live</span>
            </a>
          </HeroItem>

          <HeroItem className="mt-6 md:mt-9">
            <h1
              className={cn(
                "max-w-[920px] font-normal text-white text-[36px] leading-[1.08] tracking-[-0.02em] md:text-[64px] md:leading-[68px]",
                DISPLAY,
              )}
            >
              Your customer lifecycle belongs in your repo.
            </h1>
          </HeroItem>

          <HeroItem className="mt-4 md:mt-6">
            <p className="max-w-[680px] text-white/75 text-base leading-[24px] tracking-[-0.025em] md:text-lg md:leading-[27px]">
              Hogsend is lifecycle automation in TypeScript for product-led
              teams. Written by you or your coding agent. Shipped like the rest
              of your product.
            </p>
          </HeroItem>

          {/* Primary path (one-click Railway deploy) + the hosted demo. */}
          <HeroItem className="mt-6 md:mt-8">
            <div className="flex flex-wrap items-center justify-center gap-3">
              <Btn href={RAILWAY_DEPLOY_URL} size="lg" newTab>
                Deploy on Railway
              </Btn>
              <TrackDemoClick placement="home-hero">
                <Btn href={DEMO_URL} variant="outline" size="lg" newTab>
                  See the live demo
                </Btn>
              </TrackDemoClick>
            </div>
          </HeroItem>

          {/* The Flint prompt-card idiom: an agent ask, sitting on a soft
              two-colour blob glow. */}
          <HeroItem className="mt-8 w-full max-w-[620px] md:mt-12">
            <div className="relative w-full text-left">
              <div
                aria-hidden="true"
                className="-inset-x-16 -inset-y-10 pointer-events-none absolute"
                style={{
                  background:
                    "radial-gradient(45% 60% at 30% 60%, rgba(246,72,56,0.16), transparent 70%), radial-gradient(40% 55% at 75% 40%, rgba(35,196,137,0.14), transparent 70%)",
                  filter: "blur(24px)",
                }}
              />
              <AgentPromptLoop engineVersion={engineVersion} />
            </div>
          </HeroItem>

          <HeroItem className="mt-4 md:mt-5">
            <p className="max-w-[760px] font-mono text-[12px] text-white/45 uppercase leading-5 tracking-[0.06em]">
              Onboarding · Trial conversion · Payment recovery · Retention ·
              Win-back · Across email, in-app, SMS, Discord, and more
            </p>
          </HeroItem>
        </HeroReveal>
      </Container>

      {/* Works-with strip */}
      <div className="mt-10 border-[#f6483833] border-y md:mt-16">
        <Container className="flex flex-col gap-5 py-6 md:flex-row md:items-center md:gap-12 md:py-9">
          <span className="shrink-0 font-mono text-white/40 text-[12px] uppercase tracking-[0.08em]">
            Works with
          </span>
          <div className="relative min-w-0 flex-1 opacity-70 grayscale">
            <LogoMarquee
              items={(
                [
                  "posthog",
                  "resend",
                  "twilio",
                  "stripe",
                  "railway",
                  "typescript",
                  "segment",
                  "slack",
                ] as const satisfies readonly BrandKey[]
              ).map((brand) => (
                <BrandLogo
                  key={brand}
                  brand={brand}
                  height={22}
                  className="mx-8 text-white/55"
                />
              ))}
            />
          </div>
        </Container>
      </div>
    </section>
  );
}

function PsProductDemo() {
  return (
    <section className="relative overflow-hidden border-[#f6483826] border-t">
      <Container className="pt-20 text-center">
        <Eyebrow>Try it live</Eyebrow>
        <h2
          className={cn(
            "mx-auto mt-8 max-w-[760px] font-normal text-[34px] leading-[1.15] tracking-[-0.01em] md:text-[48px] md:leading-[56px]",
            DISPLAY,
          )}
        >
          <span className="text-white">We use Hogsend to power</span>{" "}
          <span className="text-white/40">hogsend.com.</span>
        </h2>
        <p className="mx-auto mt-5 max-w-[620px] text-base text-white/55 leading-[24px] tracking-[-0.02em]">
          Sign up below. Our own Hogsend install sends the welcome email and
          powers the feed, bell, survey, and branching that follows.
        </p>
      </Container>

      {/* A contained ink panel carrying the crimzon planet-horizon glow; the
          live product components float over it. */}
      <Container className="relative mt-12">
        <div className="relative h-[300px] overflow-hidden rounded-2xl bg-[#070303] md:h-[340px]">
          <WaveLines
            className="absolute inset-0 h-full w-full opacity-80"
            stroke="rgba(255,140,118,0.5)"
            count={8}
          />
          <div
            aria-hidden="true"
            className="absolute inset-0"
            style={{
              background:
                "radial-gradient(80% 70% at 50% 118%, rgba(246,72,56,0.85) 0%, rgba(246,72,56,0.3) 40%, rgba(246,72,56,0.07) 65%, transparent 82%)",
            }}
          />
          {/* The crisp horizon arc. */}
          <div
            aria-hidden="true"
            className="absolute inset-0"
            style={{
              background:
                "radial-gradient(58% 46% at 50% 116%, transparent 59%, rgba(255,150,128,0.9) 61.5%, rgba(255,150,128,0.12) 66%, transparent 71%)",
            }}
          />
        </div>
      </Container>

      <Container className="-mt-[210px] relative z-10 pb-20 md:-mt-[230px]">
        <PsHeroDemo />
        <p className="mt-5 text-center text-white/40 text-[13px] tracking-[-0.02em]">
          {isHogsendConfigured ? (
            <>
              This isn&rsquo;t a mock — it&rsquo;s our own install, a stock
              create-hogsend app in production. The welcome email arrives from
              hello@hogsend.com in seconds; the feed, bell, and survey card are
              real{" "}
              <code className="font-mono text-white/75">@hogsend/react</code>{" "}
              components.{" "}
            </>
          ) : (
            <>
              The feed, bell, and survey card are real{" "}
              <code className="font-mono text-white/75">@hogsend/react</code>{" "}
              components — live on hogsend.com.{" "}
            </>
          )}
          <Link href="/components" className="font-medium text-white">
            See the full set →
          </Link>
        </p>
      </Container>
    </section>
  );
}

/* ------------------------------------------------------------ proof strip -- */

/** The under-marquee band: the one-command install is the eye-turner, next to
 * the npm link. The live release version now lives up in the hero prompt card. */
function PsProofStrip() {
  return (
    <div className="border-[#f6483833] border-b">
      <Container className="flex flex-col gap-3 py-4 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-6 sm:gap-y-3">
        <span className="font-mono text-white/40 text-[12px] uppercase tracking-[0.08em]">
          In the open
        </span>
        {/* One command to first send — the real eye-turner. */}
        <span className="flex min-w-0 items-center gap-2 rounded-[6px] border border-white/10 bg-white/[0.03] py-1.5 pr-1.5 pl-3">
          <code className="min-w-0 overflow-x-auto whitespace-nowrap font-mono text-[12.5px] text-white/90 [scrollbar-width:none]">
            <span className="text-white/40">$ </span>
            {INSTALL_COMMAND}
          </code>
          <CopyButton
            value={INSTALL_COMMAND}
            className="shrink-0 text-white/40 hover:text-white"
          />
        </span>
        <Link
          href={NPM_URL}
          className="font-medium text-white text-[13px] tracking-[-0.02em] hover:opacity-70 sm:ml-auto"
        >
          npmjs.com/@hogsend →
        </Link>
      </Container>
    </div>
  );
}

/* ----------------------------------------------------- platform pitch -- */

/** The four things a product engineer needs to hear once the core mechanism
 * is clear. PostHog is one supported source, not the category Hogsend lives in. */
const PLATFORM_CARDS: { title: string; body: ReactNode }[] = [
  {
    title: "First-party events included",
    body: "Send product behaviour straight to Hogsend with @hogsend/js or @hogsend/client. Bring PostHog, Stripe, or any webhook when it helps.",
  },
  {
    title: "Lifecycle automation as code",
    body: "Every journey is a TypeScript function in your repo — reviewed, type-checked, and versioned like the rest of your product. Agents can write them.",
  },
  {
    title: "One command to first send",
    body: (
      <>
        <code className="font-mono text-[13px] text-white/75">
          create-hogsend
        </code>{" "}
        scaffolds ten journeys and thirteen email templates — deploy to Railway
        in one click, first send in minutes.
      </>
    ),
  },
  {
    title: "React components included",
    body: (
      <>
        <code className="font-mono text-[13px] text-white/75">
          @hogsend/react
        </code>{" "}
        ships the in-app feed and notification bell — drop them in and the same
        journeys reach users inside your product.
      </>
    ),
  },
];

/* Channels a journey can reach — plus the honest roadmap. */
const REACH_NOW = ["Email", "SMS", "Discord", "Slack", "In-app"];
const REACH_SOON = ["Voice agents", "Direct mail"];

/* The batteries — every one is real, in the scaffold, and demoed on the site
 * (React Email templates → /emails; the React kit + link tracking → /components). */
const TOOLKIT = [
  "13 React Email templates",
  "Vanity links, QR codes & link tracking",
  "Open & click tracking",
  "Notification bell",
  "In-app feed",
  "Preference center",
  "In-feed survey card",
  "Discord DMs & presence",
];

/** One capability chip. `soon` renders the dashed, dimmed roadmap variant. */
function PitchChip({
  children,
  soon,
}: {
  children: ReactNode;
  soon?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 rounded-[6px] px-3.5 py-1.5 font-medium text-[13px] tracking-[-0.025em]",
        soon
          ? "border border-white/10 border-dashed text-white/40"
          : "border border-white/10 bg-white/[0.06] text-white",
      )}
    >
      {!soon && (
        <span
          aria-hidden="true"
          className="size-1.5 rounded-full bg-[#f64838]"
        />
      )}
      {children}
    </span>
  );
}

function PsPlatformPitch() {
  return (
    <section className="relative border-[#f6483826] border-b">
      <Container className="pt-16 pb-20">
        <Eyebrow>Bring your stack</Eyebrow>
        <h2
          className={cn(
            "mt-6 max-w-[760px] font-normal text-[30px] leading-[1.15] tracking-[-0.02em] md:text-[40px] md:leading-[46px]",
            DISPLAY,
          )}
        >
          <span className="text-white">Works beautifully with PostHog.</span>{" "}
          <span className="text-white/40">Works without it, too.</span>
        </h2>

        <div className="mt-12 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {PLATFORM_CARDS.map((c, i) => (
            <div
              key={c.title}
              className="rounded-lg border border-white/10 bg-white/[0.03] p-6"
            >
              <span className="font-mono text-[#f64838] text-[13px]">
                {String(i + 1).padStart(2, "0")}
              </span>
              <h3 className="mt-3 font-medium text-base text-white tracking-[-0.025em]">
                {c.title}
              </h3>
              <p className="mt-2 text-sm text-white/55 leading-[21px] tracking-[-0.02em]">
                {c.body}
              </p>
            </div>
          ))}
        </div>

        {/* Reach + toolkit — the fuller inventory: every channel a journey can
            hit (incl. the roadmap) and the batteries that ship in the box. */}
        <div className="mt-10 grid grid-cols-1 gap-10 border-white/10 border-t pt-8 lg:grid-cols-2 lg:gap-12">
          <div>
            <span className="font-mono text-white/40 text-[12px] uppercase tracking-[0.08em]">
              One journey, every channel
            </span>
            <div className="mt-4 flex flex-wrap items-center gap-2.5">
              {REACH_NOW.map((channel) => (
                <PitchChip key={channel}>{channel}</PitchChip>
              ))}
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2.5">
              <span className="font-mono text-white/40 text-[11px] uppercase tracking-[0.08em]">
                Coming soon
              </span>
              {REACH_SOON.map((channel) => (
                <PitchChip key={channel} soon>
                  {channel}
                </PitchChip>
              ))}
            </div>
            <p className="mt-3 text-[12px] text-white/35 leading-5 tracking-[-0.02em]">
              Voice agents land on Vapi and Deepgram — same journey, same
              contact.
            </p>
          </div>

          <div>
            <span className="font-mono text-white/40 text-[12px] uppercase tracking-[0.08em]">
              Batteries included
            </span>
            <div className="mt-4 flex flex-wrap items-center gap-2.5">
              {TOOLKIT.map((tool) => (
                <PitchChip key={tool}>{tool}</PitchChip>
              ))}
            </div>
            <Link
              href="/components"
              className="mt-4 inline-block text-[13px] text-white/75 tracking-[-0.02em] transition-colors hover:text-white"
            >
              See the React kit demoed →
            </Link>
          </div>
        </div>
      </Container>
    </section>
  );
}

/* -------------------------------------------------------------- problem -- */

const PILLARS = [
  {
    title: "Journeys as code",
    body: "Lifecycle logic is TypeScript in your repo — reviewed, type-checked, and versioned like the rest of your product.",
  },
  {
    title: "Your provider, your reputation",
    body: "Sends go through your own Resend or Postmark account — or any provider behind the EmailProvider contract.",
  },
  {
    title: "Durable execution",
    body: "Journeys run as Hatchet durable tasks — a seven-day wait survives deploys, restarts, and crashes.",
  },
];

function PillarIcon({ index }: { index: number }) {
  // Minimal line-art marks in the Polar icon-box style.
  const marks = [
    <path key="a" d="M8 24V14l5 5 5-9 6 14" />,
    <circle key="b" cx="16" cy="16" r="7" />,
    <path key="c" d="M7 16h18M16 7v18" />,
  ];
  return (
    <span className="inline-flex size-[46px] items-center justify-center border border-white/15 bg-white/[0.04]">
      <svg
        viewBox="0 0 32 32"
        fill="none"
        stroke="#ffffff"
        strokeWidth="1.2"
        aria-hidden="true"
        className="size-8"
      >
        {marks[index % marks.length]}
      </svg>
    </span>
  );
}

function PsProblem() {
  return (
    <section className="relative border-[#f6483826] border-t overflow-hidden">
      <DotPatch className="top-24 right-0 hidden h-40 w-56 lg:block" />
      <Container className="pt-24 pb-28 md:pt-32">
        <Eyebrow>Signal → response</Eyebrow>

        <div className="mt-8 flex flex-col justify-between gap-10 lg:flex-row">
          <h2
            className={cn(
              "max-w-[560px] font-normal text-[38px] leading-[1.12] tracking-[-0.02em] md:text-[56px] md:leading-[63px]",
              DISPLAY,
            )}
          >
            {/* Scroll-linked word reveal — the homepage Manifesto animation,
                re-keyed to the light palette. */}
            <WordReveal text="When lifecycle lives in your codebase, every leak is fixable." />
          </h2>

          <div className="max-w-[340px] lg:pt-2">
            <p className="text-white/75 text-base leading-[24px] tracking-[-0.025em]">
              Onboarding stalls. Trials cool off. Payments fail. Customers go
              quiet. Hogsend turns each leak into a response your product can
              ship.
            </p>
            <div className="mt-6 flex items-center gap-6 opacity-80 grayscale">
              <BrandLogo
                brand="posthog"
                height={18}
                className="text-white/75"
              />
              <BrandLogo brand="resend" height={16} className="text-white/75" />
              <BrandLogo
                brand="typescript"
                height={18}
                className="text-white/75"
              />
            </div>
          </div>
        </div>

        {/* Product shot in a dark frame, floating over a soft gradient. */}
        <div className="relative mt-16">
          <div
            aria-hidden="true"
            className="absolute inset-x-0 top-12 bottom-0"
            style={{
              background:
                "linear-gradient(180deg, transparent 0%, rgba(246,72,56,0.18) 45%, rgba(246,120,80,0.14) 80%, transparent 100%)",
            }}
          />
          <div className="relative overflow-hidden rounded-lg border border-[#1c1d22] bg-[#101014] shadow-2xl">
            <Image
              src={studioJourneys}
              alt="Hogsend Studio — journeys observed live"
              className="w-full"
              priority
            />
          </div>
        </div>

        {/* Three line-icon pillars, Polar's under-screenshot feature row. */}
        <p className="mt-20 max-w-[420px] text-white text-lg leading-[26px] tracking-[-0.025em]">
          The lifecycle becomes part of the product—not a campaign bolted on
          beside it.
        </p>
        <div className="mt-10 grid grid-cols-1 gap-10 md:grid-cols-3">
          {PILLARS.map((p, i) => (
            <div key={p.title}>
              <PillarIcon index={i} />
              <h3 className="mt-5 font-medium text-white text-base tracking-[-0.025em]">
                {p.title}
              </h3>
              <p className="mt-2 max-w-[300px] text-white/55 text-sm leading-[21px] tracking-[-0.02em]">
                {p.body}
              </p>
            </div>
          ))}
        </div>
      </Container>
    </section>
  );
}

/* ------------------------------------------------------------- live demo -- */

/** The hosted Studio demo — demo.hogsend.com, a real seeded install anyone
 * can sign in to. Every link to it goes through TrackDemoClick, so the click
 * lands in PostHog and on the visitor's dogfood contact. */
const DEMO_CREDENTIALS = "demo@hogsend.com · forgeline-demo-2026";

function PsStudioDemo() {
  return (
    <section id="live-demo" className="relative border-[#f6483826] border-t">
      <Container className="pt-16 pb-24">
        <Eyebrow>Live demo</Eyebrow>

        <div className="mt-8 flex flex-col justify-between gap-10 lg:flex-row">
          <h2
            className={cn(
              "max-w-[620px] font-normal text-[34px] leading-[1.15] tracking-[-0.01em] md:text-[48px] md:leading-[56px]",
              DISPLAY,
            )}
          >
            <span className="text-white">A real Studio, running live.</span>{" "}
            <span className="text-white/40">Sign in and click around.</span>
          </h2>

          <p className="max-w-[380px] text-white/75 text-base leading-[24px] tracking-[-0.025em] lg:pt-2">
            demo.hogsend.com is a stock Hogsend install seeded as Forgeline — a
            fictional AI code-review product with six months of contacts,
            journeys, sends, opens, and clicks. The sign-in is shared, and no
            email provider is configured, so nothing you do in it can send real
            mail.{" "}
            <Link
              href="/docs/operating/studio"
              className="font-medium text-white"
            >
              How the Studio works →
            </Link>
          </p>
        </div>

        <div className="mt-10 flex flex-wrap items-center gap-4">
          <TrackDemoClick placement="home-demo-section">
            <Btn href={DEMO_URL} size="lg" newTab>
              Open the live demo
            </Btn>
          </TrackDemoClick>
          <span className="flex items-center gap-3 rounded-[6px] border border-white/10 bg-white/[0.04] py-3 pr-3 pl-4">
            <code className="font-mono text-[12.5px] text-white/90">
              {DEMO_CREDENTIALS}
            </code>
            <CopyButton
              value="forgeline-demo-2026"
              className="text-white/40 hover:text-white"
            />
          </span>
        </div>

        {/* The Studio itself, framed as the window you're about to open. */}
        <TrackDemoClick placement="home-demo-screenshot">
          <a
            href={DEMO_URL}
            target="_blank"
            rel="noreferrer"
            className="mt-14 block overflow-hidden rounded-xl border border-white/15 bg-[#0a0606] shadow-2xl transition-colors hover:border-white/30"
          >
            <div className="flex items-center justify-between border-white/10 border-b px-4 py-2.5">
              <div className="flex items-center gap-3">
                <div aria-hidden="true" className="flex items-center gap-1.5">
                  <span className="size-2.5 rounded-full bg-white/15" />
                  <span className="size-2.5 rounded-full bg-white/15" />
                  <span className="size-2.5 rounded-full bg-white/15" />
                </div>
                <span className="font-mono text-white/40 text-[11px] tracking-wide">
                  demo.hogsend.com/studio — Forgeline
                </span>
              </div>
              <span className="flex items-center gap-1.5 font-mono text-[#23c489] text-[11px]">
                <span className="ps-pulse size-1.5 rounded-full bg-[#23c489]" />
                live
              </span>
            </div>
            <Image
              src={studioOverview}
              alt="Hogsend Studio on the demo instance — Forgeline's overview"
              className="w-full"
            />
          </a>
        </TrackDemoClick>
      </Container>
    </section>
  );
}

/* -------------------------------------------------------------- playbook -- */

/** The lifecycle loop, spelled out as the four things you actually do. Each
 * step links to the lander that goes deep on it. */
const PLAYBOOK_STEPS = [
  {
    title: "Name the moments",
    body: (
      <>
        <code className="font-mono text-[13px] text-white/75">signed_up</code>,{" "}
        <code className="font-mono text-[13px] text-white/75">
          project.created
        </code>
        ,{" "}
        <code className="font-mono text-[13px] text-white/75">
          invoice.payment_failed
        </code>
        , quiet for 14 days. PostHog and your product emit most of these
        already; buckets detect the quiet ones.
      </>
    ),
    link: { label: "Event naming guide →", href: "/event-naming" },
  },
  {
    title: "Write the responses",
    body: (
      <>
        Each response is a journey — a TypeScript function that sends what the
        moment calls for: an email to the user, a DM in Discord, a Slack ping to
        your team, an item in the in-app feed. One journey can do all four.
      </>
    ),
    link: { label: "Browse 35 recipes →", href: "/recipes" },
  },
  {
    title: "Watch it work",
    body: (
      <>
        Every send, open, click, and answer lands back on the contact and in
        PostHog, so a journey charts like any other funnel — you can look at
        last month&rsquo;s welcome series and see what it converted.
      </>
    ),
    link: { label: "Growth metrics guide →", href: "/growth-metrics" },
  },
  {
    title: "Tweak and re-run",
    body: (
      <>
        A journey is a few dozen lines, so a change is a small diff — move the
        nudge from day 3 to day 5, rewrite the subject, add a branch. Git keeps
        every version that ever ran, and an agent can write the diff; your
        review process still applies.
      </>
    ),
    link: { label: "Built for agents →", href: "/fire-and-forget" },
  },
];

function PsPlaybook() {
  return (
    <section id="lifecycle" className="relative border-[#f6483826] border-t">
      <Container className="pt-16 pb-28">
        <Eyebrow>Lifecycle marketing</Eyebrow>

        <div className="mt-8 flex flex-col justify-between gap-10 lg:flex-row">
          <h2
            className={cn(
              "max-w-[620px] font-normal text-[34px] leading-[1.15] tracking-[-0.01em] md:text-[48px] md:leading-[56px]",
              DISPLAY,
            )}
          >
            <span className="text-white">Lifecycle marketing, spelled out</span>{" "}
            <span className="text-white/40">
              — the loop a growth team runs.
            </span>
          </h2>

          <p className="max-w-[380px] text-white/75 text-base leading-[24px] tracking-[-0.025em] lg:pt-2">
            A user signs up, tries the product, and either sticks or drifts.
            Each of those moments has a right response — a welcome minutes after
            signup, a nudge when a trial stalls, a win-back when a regular goes
            quiet. Sending the response automatically, per person, on the right
            channel is the whole discipline. PostHog already records the
            moments; Hogsend is where you write what happens next.{" "}
            <a
              href="https://course.hogsend.com"
              className="font-medium text-white"
            >
              The course
            </a>{" "}
            teaches the whole loop — Measure → Keep → Grow, from instrumenting
            PostHog to your 30/60/90-day plan; the first chapter is free. Or
            have it{" "}
            <Link href="/service" className="font-medium text-white">
              set up for you →
            </Link>
          </p>
        </div>

        <div className="mt-14 grid grid-cols-1 gap-x-10 gap-y-12 md:grid-cols-2 lg:grid-cols-4">
          {PLAYBOOK_STEPS.map((step, i) => (
            <div key={step.title} className="border-white/10 border-t pt-6">
              <span className="font-mono text-[#f64838] text-[13px]">
                {String(i + 1).padStart(2, "0")}
              </span>
              <h3 className="mt-3 font-medium text-base text-white tracking-[-0.025em]">
                {step.title}
              </h3>
              <p className="mt-2 text-sm text-white/55 leading-[21px] tracking-[-0.02em]">
                {step.body}
              </p>
              <Link
                href={step.link.href}
                className="mt-3 inline-block text-[13px] text-white/75 tracking-[-0.02em] transition-colors hover:text-white"
              >
                {step.link.label}
              </Link>
            </div>
          ))}
        </div>
      </Container>
    </section>
  );
}

/* ---------------------------------------------------------- event fanning -- */

const FAN_SCENARIOS = [
  {
    tag: "Onboarding",
    lead: "The Discord help thread.",
    rest: "Someone starts a trial, then asks for setup help in Discord. The handle and the trial account are already the same contact — the journey answers with a getting-started email and flags the stuck step to your team in Slack.",
  },
  {
    tag: "Activation",
    lead: "Watched the demo, did nothing.",
    rest: "A signup plays the demo twice but never creates a project. The journey waits three days on project.created, then sends the nudge that points at that one action.",
  },
  {
    tag: "Billing",
    lead: "Card declined.",
    rest: "A payment fails. The reminder goes out, and the journey stops the instant the payment clears — nobody who already paid gets nagged.",
  },
  {
    tag: "Community",
    lead: "Quiet in Discord.",
    rest: "A daily-active member goes silent for two weeks. The drop shows on the same contact as their product usage — a check-in goes out before they fully drift.",
  },
  {
    tag: "Sales",
    lead: "A prospect logs in.",
    rest: "A prospect your AE is chasing signs into the product. No email fires — the AE gets a Slack ping with exactly what the prospect did.",
  },
  {
    tag: "Identity",
    lead: "Anonymous, then known.",
    rest: "Someone reads pricing anonymously and signs up the next day. The pre-signup events fold onto the new contact; the welcome references what they looked at.",
  },
  {
    tag: "Timing",
    lead: "Big win at 2am.",
    rest: "A user hits a milestone in the middle of the night. Their celebration email is scheduled for their morning; the Slack high-five to your team fires now.",
  },
  {
    tag: "Pipelines",
    lead: "One Stripe event, four destinations.",
    rest: "payment_succeeded enrolls the customer, updates PostHog, posts to Slack, and starts the receipt journey — one event, no glue code.",
  },
  {
    tag: "Restraint",
    lead: "Stops the second they convert.",
    rest: "Every nudge checks the goal first. The moment they pay, the rest of the sequence never sends.",
  },
];

const AGENT_READS = [
  {
    lead: "Draft the reply, a human sends it.",
    rest: "An agent drafts the answer from the user's account state; the journey parks on an approval wait. A person edits or approves before anything sends.",
  },
  {
    lead: "Confused vs furious.",
    rest: "Two people write “this doesn't work.” One is lost — send the how-to. One just lost data — escalate to a human and suppress the automation. Same words, opposite handling.",
  },
  {
    lead: "Cancel reason → the right win-back.",
    rest: "“Too expensive for a side project” schedules a hobby-tier win-back sixty days out — not a sales call to someone who'd never take it.",
  },
];

function PsFanning() {
  return (
    <section className="relative border-[#f6483826] border-t overflow-hidden">
      <DotPatch className="top-24 right-0 hidden h-40 w-52 lg:block" />
      <Container className="relative pt-24 pb-6">
        <Reveal>
          <Eyebrow>Event fanning</Eyebrow>
          <h2
            className={cn(
              "mt-8 max-w-[880px] font-normal text-[38px] leading-[1.12] tracking-[-0.02em] md:text-[56px] md:leading-[63px]",
              DISPLAY,
            )}
          >
            <span className="text-white">
              Every signal lands on one person.
            </span>{" "}
            <span className="text-white/40">Every event can fan back out.</span>
          </h2>
          <p className="mt-6 max-w-[560px] text-white/55 text-base leading-[24px] tracking-[-0.02em]">
            Marketing site, product, Discord, Slack, Stripe — events from every
            surface land on the same contact. A journey reads the signal and
            sends whatever fits: an email to the user, a DM in Discord, a ping
            to your team, an event back to PostHog.
          </p>
        </Reveal>
      </Container>

      {/* Scenario carousel — bleeds to the frame edge; the fade is the
          scroll affordance, and the lead padding travels with the cards. */}
      <Container className="mt-12 pb-6">
        <div className="-mx-6 overflow-x-auto md:-mx-10 [scrollbar-width:none] [mask-image:linear-gradient(to_right,transparent,black_32px,black_calc(100%-120px),transparent)]">
          <div className="flex w-max gap-4 px-6 md:px-10">
            {FAN_SCENARIOS.map((s, i) => (
              <div
                key={s.lead}
                className="w-[300px] shrink-0 p-6"
                style={{
                  background:
                    i % 2 === 0
                      ? "rgba(255,255,255,0.04)"
                      : "rgba(246,72,56,0.07)",
                }}
              >
                <span className="font-mono text-[#f64838] text-[11px] uppercase tracking-[0.08em]">
                  {s.tag}
                </span>
                <p className="mt-3 text-[14.5px] leading-[22px] tracking-[-0.02em]">
                  <span className="font-medium text-white">{s.lead}</span>{" "}
                  <span className="text-white/55">{s.rest}</span>
                </p>
              </div>
            ))}
          </div>
        </div>
      </Container>

      {/* Agents read the words, not just the events. */}
      <Container className="pb-24">
        <Reveal>
          <div className="mt-10 grid grid-cols-1 gap-10 border-white/10 border-t pt-10 lg:grid-cols-[1fr_1.4fr]">
            <div>
              <h3
                className={cn(
                  "max-w-[340px] text-white text-[26px] leading-[1.2] tracking-[-0.02em]",
                  DISPLAY,
                )}
              >
                Agents read the words, not just the events.
              </h3>
              <p className="mt-4 max-w-[360px] text-white/55 text-sm leading-[21px] tracking-[-0.02em]">
                A journey is an async TypeScript function, so you can call an
                LLM inside run() and branch on its verdict — or park on a
                durable wait and let an out-of-band agent fire its decision back
                as one event. Reviewed in a PR, type-checked like everything
                else.
              </p>
            </div>
            <div className="flex flex-col">
              {AGENT_READS.map((item, i) => (
                <div
                  key={item.lead}
                  className={cn("py-4", i > 0 && "border-white/10 border-t")}
                >
                  <p className="text-[15px] leading-[23px] tracking-[-0.02em]">
                    <span className="font-medium text-white">{item.lead}</span>{" "}
                    <span className="text-white/55">{item.rest}</span>
                  </p>
                </div>
              ))}
            </div>
          </div>
        </Reveal>
      </Container>
    </section>
  );
}

/* ------------------------------------------------------------------ stats -- */

const BENCHMARKS = [
  {
    value: "25–95%",
    claim: "more profit from a 5% lift in retention",
    source: "Bain & Company",
  },
  {
    value: "~2×",
    claim: "the engagement of behaviour-triggered email vs. batch sends",
    source: "Epsilon",
  },
  {
    value: "5–25×",
    claim: "what acquiring a new customer costs vs. keeping one",
    source: "Harvard Business Review",
  },
];

function _PsStats() {
  return (
    <section className="relative border-[#f6483826] border-t">
      <Container className="relative pt-16 pb-24">
        <PlusGrid className="top-12 right-0 hidden h-44 w-72 [mask-image:linear-gradient(to_left,black,transparent)] lg:block" />
        <Reveal>
          <Eyebrow>Why it's worth doing well</Eyebrow>
          <h2
            className={cn(
              "mt-8 max-w-[860px] font-normal text-[34px] leading-[1.15] tracking-[-0.01em] md:text-[48px] md:leading-[56px]",
              DISPLAY,
            )}
          >
            <span className="text-white">
              Lifecycle email is the highest-leverage system
            </span>{" "}
            <span className="text-white/40">most teams skip.</span>
          </h2>
        </Reveal>

        {/* Flint's stat-card row: big numeral, caption, source chip. */}
        <div className="mt-12 grid grid-cols-1 gap-4 md:grid-cols-3">
          {BENCHMARKS.map((b, i) => (
            <Reveal key={b.source} delay={i * 0.08}>
              <div className="flex h-full flex-col rounded-lg border border-white/10 bg-white/[0.03] p-6">
                <span
                  className={cn(
                    "text-white text-[44px] leading-[1.1] tracking-[-0.02em]",
                    DISPLAY,
                  )}
                >
                  {b.value}
                </span>
                <p className="mt-2 max-w-[280px] text-white/55 text-sm leading-[21px] tracking-[-0.02em]">
                  {b.claim}
                </p>
                <span className="mt-6 inline-flex w-fit items-center rounded-full bg-[#f64838]/[0.08] px-3 py-1 font-mono text-[11px] text-[#f64838] uppercase tracking-[0.06em]">
                  {b.source}
                </span>
              </div>
            </Reveal>
          ))}
        </div>
      </Container>
    </section>
  );
}

/* ----------------------------------------------------------- agent cards -- */

const AGENT_CARDS = [
  {
    title: "Plain TypeScript surface",
    body: "Journeys are defineJourney() files. Claude Code, Cursor, or any agent writes and modifies them like any other code.",
    bg: "radial-gradient(130% 110% at 10% 110%, rgba(246,72,56,0.75) 0%, rgba(246,72,56,0.28) 45%, rgba(246,72,56,0.05) 80%)",
    corner: "#f64838",
    mock: (
      <div className="rounded-md bg-[#12131a]/90 p-4 font-mono text-[11.5px] text-white/80 leading-[19px] shadow-xl">
        <div aria-hidden="true" className="mb-2.5 flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-white/15" />
          <span className="size-2 rounded-full bg-white/15" />
          <span className="size-2 rounded-full bg-white/15" />
        </div>
        <p>
          <span className="text-[#8fb0ff]">export const</span> onboarding ={" "}
          <span className="text-[#8fb0ff]">defineJourney</span>({"{"}
        </p>
        <p className="pl-3">
          trigger: {"{"} event:{" "}
          <span className="text-[#a5e8b8]">"user.signed_up"</span> {"}"},
        </p>
        <p className="pl-3">
          run: <span className="text-[#8fb0ff]">async</span> (user, ctx) =&gt;{" "}
          {"{"} … {"}"},
        </p>
        <p>{"}"});</p>
      </div>
    ),
  },
  {
    title: "Validated by your type-checker",
    body: "No drag-and-drop canvas to drift out of date — the compiler rejects a journey that references a template that doesn't exist.",
    bg: "radial-gradient(130% 120% at 50% 120%, rgba(35,196,137,0.6) 0%, rgba(35,196,137,0.22) 45%, rgba(35,196,137,0.04) 80%)",
    corner: "#23c489",
    mock: (
      <div className="rounded-md bg-[#12131a]/90 p-4 font-mono text-[11.5px] text-white/80 leading-[19px] shadow-xl">
        <div aria-hidden="true" className="mb-2.5 flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-white/15" />
          <span className="size-2 rounded-full bg-white/15" />
          <span className="size-2 rounded-full bg-white/15" />
        </div>
        <p className="text-white/50"># pre-push</p>
        <p>$ pnpm check-types</p>
        <p className="text-[#9fe8c4]">✓ journeys/welcome.ts</p>
        <p className="text-[#9fe8c4]">✓ journeys/winback.ts — 0 errors</p>
      </div>
    ),
  },
  {
    title: "A CLI agents can drive",
    body: "hogsend skills plus --json on every command give agents a first-class interface to inspect and operate the running system.",
    bg: "radial-gradient(130% 110% at 90% 110%, rgba(63,104,242,0.6) 0%, rgba(143,176,255,0.22) 45%, rgba(63,104,242,0.05) 80%)",
    corner: "#5f7ef2",
    mock: (
      <div className="rounded-md bg-[#12131a]/90 p-4 font-mono text-[11.5px] text-white/80 leading-[19px] shadow-xl">
        <div aria-hidden="true" className="mb-2.5 flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-white/15" />
          <span className="size-2 rounded-full bg-white/15" />
          <span className="size-2 rounded-full bg-white/15" />
        </div>
        <p>$ hogsend journeys --json</p>
        <p className="text-white/60">
          {"["} {"{"} "id": "onboarding", "status": "registered" {"}"} … {"]"}
        </p>
      </div>
    ),
  },
];

const AGENT_CHIPS = [
  "Claude Code",
  "Cursor",
  "Copilot",
  "Or any agent you prefer",
];

/* Runtime journeys — the other half of the agent arc: an agent authors a
   journey at runtime (a JSON Blueprint) and drives the instance over MCP. */
const BLUEPRINT_CARDS: { title: string; body: ReactNode }[] = [
  {
    title: "Journey Blueprints",
    body: (
      <>
        Agents author journeys as JSON — stored in your database, enrolling
        users without a deploy. Review and enable them in Studio. When one earns
        permanence,{" "}
        <code className="font-mono text-[13px] text-white/75">
          hogsend blueprints promote
        </code>{" "}
        turns it into a code journey in your repo.
      </>
    ),
  },
  {
    title: "MCP server",
    body: (
      <>
        <code className="font-mono text-[13px] text-white/75">
          npx @hogsend/mcp
        </code>{" "}
        connects Claude Desktop, Cursor, or claude.ai to your running instance.
        Create blueprints, run health reports, send test emails — your admin
        key, your infrastructure.
      </>
    ),
  },
];

function PsAgents() {
  return (
    <section className="relative border-[#f6483826] border-t">
      <Container className="pt-16 pb-24">
        <Eyebrow>Agent-native</Eyebrow>
        <h2
          className={cn(
            "mt-8 max-w-[860px] font-normal text-white text-[38px] leading-[1.12] tracking-[-0.01em] md:text-[56px] md:leading-[63px]",
            DISPLAY,
          )}
        >
          Put your growth machine on autopilot.
        </h2>
        <p className="mt-5 max-w-[620px] text-white/60 text-lg leading-[27px] tracking-[-0.025em]">
          Your coding agent works where your lifecycle does: inside your
          codebase. Ask for an outcome and it can write, modify, and validate
          the journey without another drag-and-drop builder.
        </p>

        <div className="mt-14 grid grid-cols-1 gap-5 md:grid-cols-3">
          {AGENT_CARDS.map((c) => (
            <div
              key={c.title}
              className="relative overflow-hidden p-6 pb-8"
              style={{ background: c.bg }}
            >
              <span
                aria-hidden="true"
                className="absolute top-2 right-2 size-[10px]"
                style={{ background: c.corner }}
              />
              <h3 className="font-medium text-white text-lg tracking-[-0.025em]">
                {c.title}
              </h3>
              <p className="mt-2 min-h-[84px] max-w-[330px] text-white/70 text-sm leading-[21px] tracking-[-0.02em]">
                {c.body}
              </p>
              <div className="mt-8">{c.mock}</div>
            </div>
          ))}
        </div>

        <div className="mt-5">
          <span className="font-mono text-white/40 text-[12px] uppercase tracking-[0.08em]">
            Or authored at runtime
          </span>
          <div className="mt-4 grid grid-cols-1 gap-5 md:grid-cols-2">
            {BLUEPRINT_CARDS.map((c) => (
              <div
                key={c.title}
                className="rounded-lg border border-white/10 bg-white/[0.03] p-6"
              >
                <h3 className="font-medium text-base text-white tracking-[-0.025em]">
                  {c.title}
                </h3>
                <p className="mt-2 text-sm text-white/55 leading-[21px] tracking-[-0.02em]">
                  {c.body}
                </p>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-10 flex flex-col justify-between gap-6 border-white/10 border-t pt-8 lg:flex-row lg:items-center">
          <p className="max-w-[420px] text-white/75 text-base tracking-[-0.025em]">
            LLMs write and modify journeys like any other code in your repo
          </p>
          <div className="flex flex-wrap items-center gap-2.5">
            {AGENT_CHIPS.map((chip) => (
              <span
                key={chip}
                className="inline-flex items-center gap-2 rounded-[6px] border border-white/10 bg-white/[0.06] px-4 py-2 font-medium text-white text-sm tracking-[-0.025em]"
              >
                <span
                  aria-hidden="true"
                  className="size-2 rounded-full bg-[#f64838]"
                />
                {chip}
              </span>
            ))}
          </div>
        </div>
      </Container>
    </section>
  );
}

/* ------------------------------------------------------------------ code -- */

/* Journey samples — shortened from the use-case pages' JOURNEY_CODE
   constants, faithful to the real API (same source as the homepage picker). */
const JOURNEY_SAMPLES: Record<UseCaseValue, string> = {
  onboarding: `import { days } from "@hogsend/core";
import { defineJourney, sendEmail } from "@hogsend/engine";

export const onboarding = defineJourney({
  meta: {
    id: "onboarding",
    trigger: { event: "user.signed_up" },
    entryLimit: "once",
    exitOn: [{ event: "user.deleted" }],
  },
  run: async (user, ctx) => {
    await sendEmail({ to: user.email, template: "activation-quickstart" });

    // Park durably until THIS user creates a project — or 3 days pass.
    const { timedOut } = await ctx.waitForEvent({
      event: "project.created",
      timeout: days(3),
    });

    await sendEmail({
      to: user.email,
      template: timedOut ? "activation-nudge" : "activation-feature-highlight",
    });
  },
});`,
  trial_conversion: `import { days } from "@hogsend/core";
import { defineJourney, sendEmail } from "@hogsend/engine";

export const trialConversion = defineJourney({
  meta: {
    id: "trial-conversion",
    trigger: { event: "trial.started" },
    entryLimit: "once",
    // Paid? The journey is cancelled — even mid-wait.
    exitOn: [{ event: "subscription.created" }],
  },
  run: async (user, ctx) => {
    await ctx.sleep({ duration: days(3), label: "usage-check" });

    const { found } = await ctx.history.hasEvent({
      userId: user.id,
      event: "usage.milestone_reached",
    });
    if (found) {
      // They've found value — ask while it's fresh.
      await sendEmail({ to: user.email, template: "conversion-usage-milestone" });
    }

    await ctx.sleep({ duration: days(7), label: "trial-ending" });
    await sendEmail({ to: user.email, template: "conversion-trial-expiring" });
  },
});`,
  winback: `import { days } from "@hogsend/core";
import { defineJourney, sendEmail } from "@hogsend/engine";
import { wentDormant } from "../buckets/went-dormant.js";

export const winback = defineJourney({
  meta: {
    id: "winback",
    trigger: { event: wentDormant.entered }, // typed bucket ref
    entryLimit: "once_per_period",
    entryPeriod: days(60),
    // Came back? Exit immediately — even mid-sleep.
    exitOn: [{ event: wentDormant.left }],
  },
  run: async (user, ctx) => {
    await sendEmail({ to: user.email, template: "reactivation-checkin" });

    await ctx.sleep({ duration: days(7), label: "offer" });
    await sendEmail({ to: user.email, template: "conversion-winback-offer" });

    await ctx.sleep({ duration: days(7), label: "final" });
    await sendEmail({ to: user.email, template: "reactivation-final-nudge" });
  },
});`,
  community: `import { days } from "@hogsend/core";
import {
  defineJourney,
  sendConnectorAction,
  sendEmail,
  sendFeedItem,
} from "@hogsend/engine";

export const milestone = defineJourney({
  meta: {
    id: "milestone-celebration",
    trigger: { event: "usage.milestone_reached" },
    entryLimit: "once_per_period",
    entryPeriod: days(30),
  },
  run: async (user, ctx) => {
    // One moment, three channels — the same contact everywhere.
    await sendFeedItem({
      recipient: { userId: user.id },
      type: "milestone",
      title: "You just hit 1,000 events 🎉",
      body: "Your first-month milestone — see what changed.",
    });

    // Linked their Discord with /link? Congratulate them where they hang out.
    const dm = (await sendConnectorAction({
      connectorId: "discord",
      action: "dmMember",
      args: { member: user.email, content: "1,000 events — nice. 🎉" },
    })) as { delivered: boolean };

    // No linked Discord, or DMs closed? The email carries it instead.
    if (!dm.delivered) {
      await sendEmail({ to: user.email, template: "milestone-celebration" });
    }
  },
});`,
};

/* Provider choice is config, not journey code — the toggle swaps only this. */
const ENV_SAMPLES: Record<ProviderValue, string> = {
  resend: `# provider is config, not journey code
EMAIL_PROVIDER=resend
RESEND_API_KEY=re_…`,
  postmark: `# provider is config, not journey code
EMAIL_PROVIDER=postmark
POSTMARK_SERVER_TOKEN=…`,
};

/** Async RSC wrapper: Shiki-highlights the samples server-side and hands the
 * rendered nodes to the client picker (the homepage composition pattern). */
async function PsCode() {
  const [
    onboarding,
    trialConversion,
    winback,
    community,
    resendEnv,
    postmarkEnv,
  ] = await Promise.all([
    CodeHighlight({ code: JOURNEY_SAMPLES.onboarding, lang: "ts" }),
    CodeHighlight({ code: JOURNEY_SAMPLES.trial_conversion, lang: "ts" }),
    CodeHighlight({ code: JOURNEY_SAMPLES.winback, lang: "ts" }),
    CodeHighlight({ code: JOURNEY_SAMPLES.community, lang: "ts" }),
    CodeHighlight({ code: ENV_SAMPLES.resend, lang: "bash" }),
    CodeHighlight({ code: ENV_SAMPLES.postmark, lang: "bash" }),
  ]);

  return (
    <section className="relative border-[#f6483826] border-t overflow-hidden">
      <DotPatch className="top-20 right-0 hidden h-36 w-48 lg:block" />
      <Container className="relative pt-16 pb-28">
        <Reveal>
          <Eyebrow>The code</Eyebrow>
          <h2
            className={cn(
              "mt-8 max-w-[820px] font-normal text-[34px] leading-[1.15] tracking-[-0.01em] md:text-[48px] md:leading-[56px]",
              DISPLAY,
            )}
          >
            <span className="text-white">
              Pick a use case, read the journey.
            </span>{" "}
            <span className="text-white/40">
              Swap the provider underneath; the journey doesn't change.
            </span>
          </h2>
        </Reveal>

        <Reveal delay={0.1} className="mt-12 block">
          <PsCodePicker
            journeys={{
              onboarding,
              trial_conversion: trialConversion,
              winback,
              community,
            }}
            envs={{ resend: resendEnv, postmark: postmarkEnv }}
            raw={JOURNEY_SAMPLES}
          />
        </Reveal>
      </Container>
    </section>
  );
}

/* -------------------------------------------------- elephant in the room -- */

const ELEPHANT_COLUMNS = [
  {
    label: "What Workflows does well",
    accent: false,
    cards: [
      {
        lead: "Zero extra infrastructure.",
        rest: "A tab in the PostHog UI your team already has open, consuming the events you already capture — nothing to deploy, nothing to operate.",
      },
      {
        lead: "Multi-channel out of the box.",
        rest: "Email, SMS, push, Slack, and webhooks without writing a line.",
      },
      {
        lead: "Non-engineers can ship.",
        rest: "The no-code canvas means whoever owns lifecycle can see and edit the flow — no developer in the loop.",
      },
      {
        lead: "A genuinely generous free tier.",
        rest: "Light volume fits inside it; after that it's per-send pricing on top of your PostHog bill.",
      },
    ],
  },
  {
    label: "Why you'd reach for Hogsend",
    accent: true,
    cards: [
      {
        lead: "The flow is code you own.",
        rest: "Versioned completely — git log knows who changed the discount email and why. PR review, tests, and rollback apply like everywhere else.",
      },
      {
        lead: "Your domain, your reputation.",
        rest: "Sends go through your own Resend or Postmark account, not a managed sender.",
      },
      {
        lead: "Past the canvas ceiling.",
        rest: "Park until this user acts, send in their timezone, trigger journeys from journeys, cap re-entries — control flow boxes and arrows can't express.",
      },
      {
        lead: "Integrate any service.",
        rest: "A journey is an async TypeScript function — call any API you can import, or an LLM mid-run, and branch on the answer.",
      },
    ],
  },
];

function PsElephant() {
  return (
    <section
      id="posthog-workflows"
      className="relative border-[#f6483826] border-t"
    >
      <Container className="pt-16 pb-28">
        <Reveal>
          <Eyebrow>The elephant in the room</Eyebrow>

          <div className="mt-8 flex flex-col justify-between gap-10 lg:flex-row">
            <h2
              className={cn(
                "max-w-[620px] font-normal text-[34px] leading-[1.15] tracking-[-0.01em] md:text-[48px] md:leading-[56px]",
                DISPLAY,
              )}
            >
              <span className="text-white">
                Why not just use PostHog Workflows?
              </span>{" "}
              <span className="text-white/40">Sometimes you should.</span>
            </h2>

            <p className="max-w-[380px] text-white/75 text-base leading-[24px] tracking-[-0.025em] lg:pt-2">
              Workflows is genuinely good. It lives in the PostHog UI your team
              already has open, consumes the events you already capture, and
              needs nothing deployed. If you're a PostHog team — or about to
              become one — it will cover a lot of your early automation, and you
              should let it.
            </p>
          </div>
        </Reveal>

        <div className="mt-14 grid grid-cols-1 gap-10 md:grid-cols-2 lg:grid-cols-[1fr_1fr_auto]">
          {ELEPHANT_COLUMNS.map((col) => (
            <div key={col.label}>
              <span
                className={cn(
                  "font-mono text-[11px] uppercase tracking-[0.08em]",
                  col.accent ? "text-[#f64838]" : "text-white/40",
                )}
              >
                {col.label}
              </span>
              <div className="mt-4 flex flex-col gap-3">
                {col.cards.map((card) => (
                  <div
                    key={card.lead}
                    className={cn(
                      "rounded-lg border p-5",
                      col.accent
                        ? "border-[#f64838]/25 bg-[#f64838]/[0.06]"
                        : "border-white/10 bg-white/[0.03]",
                    )}
                  >
                    <p className="text-[14px] leading-[21px] tracking-[-0.02em]">
                      <span className="font-medium text-white">
                        {card.lead}
                      </span>{" "}
                      <span className="text-white/55">{card.rest}</span>
                    </p>
                  </div>
                ))}
              </div>
            </div>
          ))}
          {/* The elephant, literally in the room — feet on the rule below.
              Hover: he leans in and owns up. Pure CSS, no client JS. */}
          <div className="group relative hidden self-end lg:block">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute -top-9 right-2 w-max translate-y-1 rounded-lg bg-white px-3.5 py-2 font-medium text-[#0a0a0a] text-[13px] tracking-[-0.02em] opacity-0 shadow-lg transition-all duration-300 ease-out group-hover:translate-y-0 group-hover:opacity-100"
            >
              Don&rsquo;t mind me — you can use both.
              <span className="-bottom-1 absolute right-10 size-2 rotate-45 bg-white" />
            </div>
            <Image
              src={postphant}
              alt="Postphant — the elephant in the room"
              className="w-[180px] origin-bottom translate-y-10 transition-all duration-300 ease-out group-hover:-rotate-2 group-hover:translate-y-8 group-hover:scale-[1.07]"
            />
          </div>
        </div>

        <div className="mt-10 flex flex-col justify-between gap-6 border-white/10 border-t pt-8 lg:flex-row lg:items-center">
          <p className="max-w-[640px] text-white/75 text-base leading-[24px] tracking-[-0.025em]">
            They scratch different itches. If you want a drag-and-drop editor,
            Workflows has you covered — you're here because you'd rather build
            marketing in, as a developer or a product-first engineering team.
            And it isn't either/or: both run off the same PostHog events, so use
            each where it fits. Hogsend amplifies everything PostHog does.
          </p>
          <Btn href="/docs/compare/posthog-workflows" variant="outline">
            Read the full comparison
          </Btn>
        </div>
      </Container>
    </section>
  );
}

/* ---------------------------------------------------------- how it works -- */

const DEPLOY_LINES = [
  { text: "# One-click Railway template, or your own host", dim: true },
  { text: "$ git push origin main", dim: false },
  { text: "→ building hogsend-api …", dim: true },
  { text: "→ building hogsend-worker …", dim: true },
  { text: "→ migrations applied · health check /v1/health ✓", dim: false },
  { text: "# Watch every send in Studio", dim: true },
];

const SCAFFOLD_LINES = [
  { text: "$ pnpm dlx create-hogsend@latest my-app", dim: false },
  { text: "✔ Scaffolding my-app", dim: true },
  { text: "✔ 10 journeys · 13 templates · Docker + env wired", dim: true },
  { text: "→ cd my-app && pnpm bootstrap", dim: false },
];

/** Light journey-trace mock — the crimzon JourneyTrace clip, redrawn in the
 * light system: trigger → send → durable wait (pulsing) → branch. */
function PsJourneyTraceMock() {
  const steps = [
    { kind: "trigger", label: "user.signed_up", note: "trigger" },
    { kind: "send", label: "activation-quickstart", note: "sendEmail" },
    {
      kind: "wait",
      label: "project.created — 3d timeout",
      note: "ctx.waitForEvent · survives deploys",
    },
    {
      kind: "branch",
      label: "timedOut ? nudge : feature-highlight",
      note: "branch",
    },
  ];
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-6">
      <span className="font-mono text-white/40 text-[11px] tracking-wide">
        src/journeys/onboarding.ts — run
      </span>
      <div className="mt-4 flex flex-col">
        {steps.map((s, i) => (
          <div key={s.label} className="flex gap-4">
            <div className="flex flex-col items-center">
              <span
                className={cn(
                  "mt-1 inline-flex size-3 shrink-0 rounded-full",
                  s.kind === "wait"
                    ? "ps-pulse bg-[#f64838]"
                    : s.kind === "trigger"
                      ? "bg-white"
                      : "border-2 border-white/30 bg-transparent",
                )}
              />
              {i < steps.length - 1 && (
                <span className="my-1 w-px flex-1 bg-white/15" />
              )}
            </div>
            <div className="pb-5">
              <p className="font-mono text-white text-[13px]">{s.label}</p>
              <p className="mt-0.5 font-mono text-white/40 text-[11px]">
                {s.note}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const HOW_STEPS = [
  {
    n: "01",
    title: "Scaffold your app",
    body: "pnpm create hogsend@latest emits a thin app that pins @hogsend/engine and holds your content. Pass --domain to wire your sending domain from the start.",
    media: (
      <div className="overflow-hidden rounded-2xl bg-[#0a0a0c]">
        <div className="flex items-center gap-3 border-white/[0.06] border-b px-4 py-2.5">
          <div aria-hidden="true" className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-full bg-white/15" />
            <span className="size-2.5 rounded-full bg-white/15" />
            <span className="size-2.5 rounded-full bg-white/15" />
          </div>
          <span className="font-mono text-[11px] text-white/40 tracking-wide">
            zsh — my-app
          </span>
        </div>
        <div className="p-5 font-mono text-[12.5px] leading-[22px]">
          {SCAFFOLD_LINES.map((l) => (
            <p
              key={l.text}
              className={l.dim ? "text-white/40" : "text-white/85"}
            >
              {l.text}
            </p>
          ))}
        </div>
      </div>
    ),
  },
  {
    n: "02",
    title: "Define journeys & buckets",
    body: "TypeScript functions that trigger on events, send emails, wait, branch, and adapt.",
    media: <PsJourneyTraceMock />,
  },
  {
    n: "03",
    title: "Deploy & watch it run",
    body: "Host with Docker or one-click Railway. Watch every send in Studio.",
    media: (
      <div className="overflow-hidden rounded-2xl bg-[#0a0a0c]">
        <div className="flex items-center gap-3 border-white/[0.06] border-b px-4 py-2.5">
          <div aria-hidden="true" className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-full bg-white/15" />
            <span className="size-2.5 rounded-full bg-white/15" />
            <span className="size-2.5 rounded-full bg-white/15" />
          </div>
          <span className="font-mono text-[11px] text-white/40 tracking-wide">
            deploy
          </span>
        </div>
        <div className="p-5 font-mono text-[12.5px] leading-[22px]">
          {DEPLOY_LINES.map((l) => (
            <p
              key={l.text}
              className={l.dim ? "text-white/40" : "text-white/85"}
            >
              {l.text}
            </p>
          ))}
        </div>
      </div>
    ),
  },
];

function _PsHowItWorks() {
  return (
    <section className="relative border-[#f6483826] border-t overflow-hidden">
      <PlusGrid className="top-28 left-0 hidden h-40 w-52 [mask-image:linear-gradient(to_right,black,transparent)] lg:block" />
      <Container className="relative pt-24 pb-16">
        {/* Sticky header column — the original ProcessSteps scroll idiom. */}
        <div className="grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,360px)_1fr]">
          <div className="lg:sticky lg:top-24 lg:self-start">
            <Eyebrow>How it works</Eyebrow>
            <h2
              className={cn(
                "mt-8 font-normal text-white text-[38px] leading-[1.12] tracking-[-0.02em] md:text-[48px] md:leading-[54px]",
                DISPLAY,
              )}
            >
              The whole job is one afternoon.
            </h2>
            <p className="mt-6 max-w-[420px] text-white/55 text-base leading-[24px] tracking-[-0.02em]">
              Activity comes from your product SDK, PostHog, Stripe, or any
              webhook. Journeys act across your providers, then fan every
              outcome back to your tools. Scaffolding is one command, the ten
              journeys ship pre-written, and deploy is a git push — the
              afternoon goes on editing copy and timings to fit your product.
            </p>
          </div>

          <div className="flex flex-col">
            {HOW_STEPS.map((step, i) => (
              <Reveal key={step.n}>
                <div
                  className={cn("py-10", i > 0 && "border-white/10 border-t")}
                >
                  <span className="font-mono text-[#f64838] text-[13px]">
                    {step.n}
                  </span>
                  <h3
                    className={cn(
                      "mt-3 text-white text-[24px] leading-[1.2] tracking-[-0.02em]",
                      DISPLAY,
                    )}
                  >
                    {step.title}
                  </h3>
                  <p className="mt-3 max-w-[520px] text-white/55 text-sm leading-[21px] tracking-[-0.02em]">
                    {step.body}
                  </p>
                  <div className="mt-6 min-w-0">{step.media}</div>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </Container>
    </section>
  );
}

/* -------------------------------------------------------- building blocks -- */

const BLOCK_JOURNEY = `export const welcome = defineJourney({
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

const BLOCK_WAIT = `run: async (user, ctx) => {
  await sendEmail({ to: user.email, template: "welcome" });
  // Wait up to 7 days for them to activate — durable, survives deploys.
  const { timedOut } = await ctx.waitForEvent({
    event: "feature_used",
    timeout: days(7),
  });
  if (timedOut) {
    await sendEmail({ to: user.email, template: "nudge" });
  }
}`;

const BLOCK_ANSWERS = `// In the email template — the click IS the answer.
<EmailAction event="nps.answered" properties={{ score: "likely" }}>
  Very likely
</EmailAction>

// In the journey — branch on what they clicked.
const { properties } = await ctx.waitForEvent({
  event: "nps.answered",
  timeout: days(3),
});`;

const BLOCK_TRACKING = `run: async (user, ctx) => {
  await sendEmail({ to: user.email, template: "welcome" });
  await ctx.sleep({ duration: days(1) });
  const { sent, count } = await ctx.history.email({
    email: user.email,
    template: "welcome",
  });
  if (sent && count > 0) {
    // Fire a signal that fans out to your destinations.
    await ctx.trigger({ event: "welcome_email_engaged", userId: user.id });
  }
}`;

const BLOCK_PROVIDER = `# .env — provider is config, not journey code
EMAIL_PROVIDER=postmark   # or resend
POSTMARK_SERVER_TOKEN=…

# The journey file doesn't change.`;

const BLOCK_BUCKET = `export const wentDormant = defineBucket({
  meta: {
    id: "went-dormant",
    enabled: true,
    timeBased: true,
    criteria: (b) =>
      b.all(
        b.event("app.active").exists(),
        b.event("app.active").within(days(7)).notExists(),
      ),
  },
});`;

const BLOCK_DESTINATIONS = `// Fan email + lifecycle events out to PostHog,
// Segment, Slack, or any signed webhook.
await hs.webhooks.create({
  kind: "slack",
  url: "https://hooks.slack.com/services/…",
  eventTypes: ["email.bounced", "email.complained"],
});

// Or define your own destination in code:
export const crm = defineDestination({
  meta: { id: "crm", name: "CRM" },
  events: ["contact.created", "contact.updated"],
  transform: (envelope, { endpoint }) => ({
    url: endpoint.url,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(envelope),
  }),
});`;

const BLOCK_POSTHOG = `# The scaffold already asked "Are you using PostHog?"
# → POSTHOG_API_KEY · POSTHOG_HOST · webhook secret minted

# Once deployed, one command finishes the loop:
$ hogsend connect posthog

→ browser opens · one consent click (OAuth, PKCE)
→ credential stored encrypted, server-side
→ person reads wired — timezones, property conditions
→ PostHog → Hogsend webhook provisioned (idempotent)`;

/** The homepage BuildingBlocks showcase, re-set light: a vertical tab rail
 * over real-code panels (async Shiki nodes composed into the client tabs). */
async function PsBuildingBlocks() {
  const [
    journeyMedia,
    waitMedia,
    answersMedia,
    trackingMedia,
    providerMedia,
    bucketMedia,
    destinationsMedia,
    posthogMedia,
  ] = await Promise.all([
    CodeHighlight({ code: BLOCK_JOURNEY, lang: "ts" }),
    CodeHighlight({ code: BLOCK_WAIT, lang: "ts" }),
    CodeHighlight({ code: BLOCK_ANSWERS, lang: "tsx" }),
    CodeHighlight({ code: BLOCK_TRACKING, lang: "ts" }),
    CodeHighlight({ code: BLOCK_PROVIDER, lang: "bash" }),
    CodeHighlight({ code: BLOCK_BUCKET, lang: "ts" }),
    CodeHighlight({ code: BLOCK_DESTINATIONS, lang: "ts" }),
    CodeHighlight({ code: BLOCK_POSTHOG, lang: "bash" }),
  ]);

  const tabs = [
    {
      id: "journeys",
      label: "Journeys",
      title: "Emails that play out over time",
      description:
        "Trigger on an event, send, sleep, then branch on what happened while you waited. The control flow is plain TypeScript.",
      tags: ["Trigger on events", "Sleep & branch", "Stop on conversion"],
      filename: "src/journeys/welcome.ts",
      media: journeyMedia,
    },
    {
      id: "wait",
      label: "Wait for event",
      title: "Wait for what they do next",
      description:
        "Pause the journey until the user acts or a timeout wins. The wait is durable, so it survives deploys, and the branch afterwards is an if statement.",
      tags: ["Durable wait", "Event or timeout", "Survives deploys"],
      filename: "src/journeys/welcome.ts",
      media: waitMedia,
    },
    {
      id: "answers",
      label: "In-email answers",
      title: "Ask a question inside the email",
      description:
        "A yes/no, an NPS score, a one-tap choice — each answer is a link whose click fires a real event with its payload. The journey branches on the answer; PostHog receives it under your event name.",
      tags: ["NPS & yes/no", "Answer = event", "Scanner-safe"],
      filename: "src/emails/nps.tsx",
      media: answersMedia,
    },
    {
      id: "tracking",
      label: "Tracking",
      title: "Opens and clicks, first-party",
      description:
        "Every send is tracked first-party for opens and link clicks; engagement flows back as events you can branch on mid-journey or fan out to your destinations.",
      tags: ["Open tracking", "Click tracking", "Any channel"],
      filename: "src/journeys/welcome.ts",
      media: trackingMedia,
    },
    {
      id: "provider",
      label: "Your provider",
      title: "Send through your own account",
      description:
        "Email goes out through your own Resend or Postmark — your domain, your reputation, your costs. Swapping the provider is one env var; the journey code never changes.",
      tags: ["Resend · Postmark", "Your domain", "Config, not code"],
      filename: ".env",
      media: providerMedia,
    },
    {
      id: "buckets",
      label: "Buckets",
      title: "Live groups of people",
      description:
        "Define who belongs with declarative criteria. Membership updates as events arrive, and joining a bucket can kick off a journey on its own.",
      tags: ["Live membership", "Time-based", "Kick off journeys"],
      filename: "src/buckets/went-dormant.ts",
      media: bucketMedia,
    },
    {
      id: "destinations",
      label: "Destinations",
      title: "Fan events out, durably",
      description:
        "Send email and lifecycle events out to PostHog, Segment, Slack, or any signed webhook. Each delivery is retried, signed, and dead-lettered for you.",
      tags: [
        "PostHog · Segment · Slack",
        "Signed & retried",
        "Define your own",
      ],
      filename: "src/destinations/crm.ts",
      media: destinationsMedia,
    },
    {
      id: "posthog",
      label: "PostHog",
      title: "Connect PostHog in one command",
      description:
        "The scaffold asks if you're using PostHog and writes the keys. Once deployed, hogsend connect posthog opens one browser consent and wires the rest.",
      tags: ["One command, one click", "Person reads wired", "Round-trip safe"],
      filename: "terminal",
      media: posthogMedia,
    },
  ];

  return (
    <section className="relative border-[#f6483826] border-t">
      <Container className="pt-16 pb-24">
        <Reveal>
          <Eyebrow>Building blocks</Eyebrow>
          <h2
            className={cn(
              "mt-8 max-w-[820px] font-normal text-[34px] leading-[1.15] tracking-[-0.01em] md:text-[48px] md:leading-[56px]",
              DISPLAY,
            )}
          >
            <span className="text-white">What it does,</span>{" "}
            <span className="text-white/40">
              shown as the code you'd write.
            </span>
          </h2>
        </Reveal>
        <Reveal delay={0.1} className="mt-12 block">
          <PsBlocksTabs tabs={tabs} />
        </Reveal>
      </Container>
    </section>
  );
}

/* ---------------------------------------------------------------- setup -- */

function PsSetup() {
  return (
    <section className="relative">
      <Container className="relative">
        {/* Aura backdrop: warm core, crimzon ring — contained in the frame. */}
        <div
          aria-hidden="true"
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(60% 55% at 50% 42%, rgba(253,220,180,0.16) 0%, rgba(246,110,88,0.14) 28%, rgba(246,72,56,0.10) 62%, rgba(246,72,56,0.03) 85%, transparent 100%)",
          }}
        />
        <div className="relative flex flex-col items-center pt-28 pb-32 text-center">
          <Eyebrow>Start building</Eyebrow>
          <h2
            className={cn(
              "mt-8 max-w-[880px] font-normal text-white text-[40px] leading-[1.12] tracking-[-0.02em] md:text-[64px] md:leading-[72px]",
              DISPLAY,
            )}
          >
            Your first journey is one command away.
          </h2>

          <div className="mt-12 flex w-full max-w-[680px] items-center gap-2 rounded-lg border border-white/10 bg-[#101014] p-2 pl-3 shadow-xl sm:gap-4 sm:pl-5">
            <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-left font-mono text-[11px] text-white/90 sm:text-[13.5px]">
              <span className="text-white/40">$ </span>
              {INSTALL_COMMAND}
            </code>
            <CopyButton value={INSTALL_COMMAND} className="shrink-0" />
          </div>

          <p className="mt-5 max-w-[560px] text-white/45 text-sm leading-[22px] tracking-[-0.02em]">
            Free to self-host · No per-contact billing · Journeys ready to
            customize
          </p>
        </div>
      </Container>
    </section>
  );
}

/* -------------------------------------------------------- core platform -- */

function PsCorePlatform() {
  return (
    <section className="relative">
      <Container className="py-20">
        <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-[#0a0606] p-8 text-white md:p-12">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                "radial-gradient(60% 80% at 0% 20%, rgba(246,72,56,0.2), rgba(246,72,56,0.05) 45%, transparent 70%)",
            }}
          />
          <WaveLines
            className="-top-8 absolute right-0 h-56 w-[62%] opacity-60"
            stroke="rgba(246,72,56,0.4)"
            count={6}
          />
          <div className="relative">
            <Eyebrow light>Core platform</Eyebrow>
            <h2
              className={cn(
                "mt-8 max-w-[720px] font-normal text-[36px] text-white leading-[1.12] tracking-[-0.01em] md:text-[52px] md:leading-[58px]",
                DISPLAY,
              )}
            >
              Lifecycle infrastructure for the stack you already run.
            </h2>

            <div className="mt-16 grid grid-cols-1 gap-10 lg:grid-cols-2">
              <div>
                <div className="overflow-hidden rounded-md border border-white/10">
                  <Image
                    src={studioJourneys}
                    alt="Hogsend Studio — journey runs"
                    className="w-full"
                  />
                </div>
                <h3 className="mt-6 font-medium text-base text-white tracking-[-0.025em]">
                  Journeys as code, observed live
                </h3>
                <p className="mt-2 max-w-[460px] text-sm text-white/60 leading-[21px] tracking-[-0.02em]">
                  Every journey is one TypeScript file — trigger, durable waits,
                  branches. Studio shows each run, wait, and send as it happens.
                </p>
              </div>
              <div>
                <div className="overflow-hidden rounded-md border border-white/10">
                  <Image
                    src={studioSends}
                    alt="Hogsend Studio — sends"
                    className="w-full"
                  />
                </div>
                <h3 className="mt-6 font-medium text-base text-white tracking-[-0.025em]">
                  Every send accounted for
                </h3>
                <p className="mt-2 max-w-[460px] text-sm text-white/60 leading-[21px] tracking-[-0.02em]">
                  First-party opens and clicks land back on the contact — and
                  fan out to PostHog, Segment, or Slack, with retries and a
                  dead-letter queue.
                </p>
              </div>
            </div>
          </div>
        </div>
      </Container>
    </section>
  );
}

/* ------------------------------------------------------------ in the open -- */

const OPEN_ROWS = [
  {
    label: "Source-available under ELv2",
    detail:
      "Read, modify, and self-host all of it for free — the only restriction is offering Hogsend itself as a managed service.",
  },
  { label: "11 packages on npm", detail: null },
  { label: "One-click Railway template", detail: null },
];

function PsOpen() {
  return (
    <section className="relative">
      <Container className="py-20">
        <div className="relative overflow-hidden rounded-2xl border border-[#f6483826]">
          <div
            aria-hidden="true"
            className="absolute inset-y-0 left-0 w-[55%]"
            style={{
              background:
                "linear-gradient(105deg, rgba(246,72,56,0.22) 0%, rgba(246,72,56,0.08) 55%, rgba(255,255,255,0) 100%)",
            }}
          />
          <DotPatch className="bottom-8 left-8 h-28 w-56 opacity-70" />
          <div className="relative grid grid-cols-1 gap-14 p-8 md:p-12 lg:grid-cols-2">
            <div>
              <Eyebrow>In the open</Eyebrow>
              <h2
                className={cn(
                  "mt-8 max-w-[420px] font-normal text-white text-[38px] leading-[1.12] tracking-[-0.02em] md:text-[56px] md:leading-[63px]",
                  DISPLAY,
                )}
              >
                An engine you can read end to end.
              </h2>
            </div>

            <div className="flex flex-col justify-center">
              {OPEN_ROWS.map((row, i) => (
                <div
                  key={row.label}
                  className={cn(
                    "flex flex-col gap-6 py-5 md:flex-row md:items-start",
                    i > 0 && "border-white/10 border-t",
                  )}
                >
                  <p
                    className={cn(
                      "min-w-[260px] text-white text-lg tracking-[-0.025em]",
                      DISPLAY,
                    )}
                  >
                    {row.label}
                  </p>
                  {row.detail && (
                    <p className="border-white/15 text-white/55 text-sm leading-[21px] tracking-[-0.02em] md:border-l md:pl-6">
                      {row.detail}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </Container>
    </section>
  );
}

/* ------------------------------------------------------ platform features -- */

const FEATURE_CARDS = [
  {
    lead: "Durable waits survive deploys.",
    rest: "A user three days into a seven-day wait keeps waiting through restarts and crashes, and resumes exactly where they were.",
    tint: "rgba(246,72,56,0.07)",
  },
  {
    lead: "In-email answers branch the journey.",
    rest: "Ask a question inside the email — the click is the answer, and the journey branches on it.",
    tint: "rgba(255,255,255,0.04)",
  },
  {
    lead: "First-party opens and clicks.",
    rest: "Links are rewritten on send; engagement lands on your domain and fans back to PostHog as first-party events.",
    tint: "rgba(246,72,56,0.07)",
  },
  {
    lead: "Buckets are live groups of people.",
    rest: "Contacts enter and leave on behaviour — kick off journeys on either edge.",
    tint: "rgba(255,255,255,0.04)",
  },
  {
    lead: "Events fan out, durably.",
    rest: "A fixed 13-event catalog goes back out to PostHog, Segment, Slack, or any signed webhook — with retries, backoff, and a dead-letter queue.",
    tint: "rgba(246,72,56,0.07)",
  },
  {
    lead: "Provider is config, not code.",
    rest: "EMAIL_PROVIDER=postmark swaps the wire underneath — the journey doesn't change.",
    tint: "rgba(255,255,255,0.04)",
  },
  {
    lead: "Revenue lands on the timeline.",
    rest: "value and currency are first-class columns on every event — a sale counts once, in its own currency, and your PostHog mirror sees the same number.",
    tint: "rgba(246,72,56,0.07)",
  },
  {
    lead: "Deal funnels move on your events.",
    rest: "Ordered stages with money milestones — deal.quoted and deal.sold mint themselves as revenue happens. Bind a CRM, or run without one.",
    tint: "rgba(255,255,255,0.04)",
  },
  {
    lead: "Attribution, eight models at once.",
    rest: "Every conversion writes a credit ledger under all eight models — switch lenses in reporting, never re-derive. Holdouts add real incrementality.",
    tint: "rgba(246,72,56,0.07)",
  },
];

function PsFeatures() {
  return (
    <section className="relative border-[#f6483826] border-t">
      <Container className="pt-24 pb-10">
        <Eyebrow>Platform features</Eyebrow>
        <div className="mt-8 flex items-end justify-between gap-8">
          <h2
            className={cn(
              "max-w-[880px] font-normal text-[34px] leading-[1.15] tracking-[-0.01em] md:text-[48px] md:leading-[56px]",
              DISPLAY,
            )}
          >
            <span className="text-white">
              Your lifecycle logic, however it branches,
            </span>{" "}
            <span className="text-white/40">
              supported by primitives built for production.
            </span>
          </h2>
          <div className="hidden shrink-0 items-center gap-2 pb-2 md:flex">
            <span className="inline-flex size-10 items-center justify-center rounded-[6px] border border-white/10 text-white/40">
              ←
            </span>
            <span className="inline-flex size-10 items-center justify-center rounded-[6px] border border-white/30 text-white">
              →
            </span>
          </div>
        </div>
      </Container>

      <Container className="pb-24">
        <div className="-mx-6 overflow-x-auto md:-mx-10 [scrollbar-width:none] [mask-image:linear-gradient(to_right,transparent,black_32px,black_calc(100%-120px),transparent)]">
          <div className="flex w-max gap-4 px-6 md:px-10">
            {FEATURE_CARDS.map((c) => (
              <div
                key={c.lead}
                className="w-[280px] shrink-0 p-6"
                style={{ background: c.tint }}
              >
                <p className="text-[15px] leading-[22px] tracking-[-0.02em]">
                  <span className="font-medium text-white">{c.lead}</span>{" "}
                  <span className="text-white/55">{c.rest}</span>
                </p>
              </div>
            ))}
          </div>
        </div>
      </Container>
    </section>
  );
}

/* ------------------------------------------------------- built on posthog -- */

const LOOP_ITEMS = [
  {
    title: "Engagement becomes PostHog events",
    body: "Every send, open and click fans back as a first-party event. Build cohorts and funnels on email behaviour.",
  },
  {
    title: "Triggered off events you already have",
    body: "Journeys react to your PostHog events directly. No reverse-ETL, no sync lag, no second source of truth.",
  },
  {
    title: "Write answers back onto the person",
    body: "An NPS score, a survey reply, a milestone — written back with identify() onto the PostHog person.",
  },
  {
    title: "Follow people into Discord",
    body: "See who joins, who's talking, and who's gone quiet — on the same contact as their email and product activity.",
  },
  {
    title: "One profile across everything",
    body: "Email, product activity, Discord and PostHog sit on a single contact.",
  },
  {
    title: "Identities stitched together",
    body: "discord_id, email and anonymous IDs fold into one person as you learn who they are.",
  },
];

/** First-party tracking, animated: event pills travel from the email to the
 * destinations on a shared clock (home.css keyframes, deterministic). */
function PsTrackingAnimation() {
  const pills = [
    { label: "email.opened", top: "top-3", delay: 0 },
    { label: "email.link_clicked", top: "top-[calc(50%-14px)]", delay: 3 },
    { label: "nps.answered", top: "bottom-3", delay: 6 },
  ];
  const dests = [
    { label: "PostHog", delay: 0 },
    { label: "Slack #growth", delay: 3 },
    { label: "posthog.identify()", delay: 6 },
  ];
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6">
      <div className="flex items-center justify-between">
        <span className="font-mono text-white/40 text-[11px] uppercase tracking-[0.08em]">
          First-party tracking
        </span>
        <span className="flex items-center gap-1.5 font-mono text-[#23c489] text-[11px]">
          <span className="ps-pulse size-1.5 rounded-full bg-[#23c489]" />
          live
        </span>
      </div>

      <div className="mt-5 grid grid-cols-1 items-center gap-4 sm:grid-cols-[1fr_minmax(150px,220px)_auto]">
        {/* The email, links rewritten on send. */}
        <div className="rounded-lg border border-white/10 bg-white/[0.04] p-4">
          <p className="font-mono text-white/40 text-[11px]">
            from: hello@yourapp.com
          </p>
          <p className="mt-1.5 font-medium text-white text-[13px] tracking-[-0.02em]">
            Welcome — one thing to try first
          </p>
          <div className="mt-2.5 space-y-1.5">
            <div className="h-1.5 w-11/12 rounded bg-white/10" />
            <div className="h-1.5 w-3/4 rounded bg-white/10" />
          </div>
          <p className="mt-3 font-medium text-[13px] text-[#f64838] underline decoration-[#f64838]/40 underline-offset-2 tracking-[-0.02em]">
            View your dashboard →
          </p>
          <p className="mt-2 font-mono text-white/40 text-[10px]">
            links rewritten on send · opens pixel injected
          </p>
        </div>

        {/* Travel lane. */}
        <div className="relative hidden h-28 [--ps-lane:110px] sm:block md:[--ps-lane:150px]">
          <div
            aria-hidden="true"
            className="absolute inset-y-2 left-1/2 border-white/10 border-l border-dashed"
          />
          {pills.map((pill) => (
            <span
              key={pill.label}
              className={cn(
                "ps-travel absolute left-0 rounded-full border border-[#f64838]/30 bg-[#f64838]/[0.08] px-2.5 py-1 font-mono text-[#f64838] text-[10.5px]",
                pill.top,
              )}
              style={{ animationDelay: `${pill.delay}s` }}
            >
              {pill.label}
            </span>
          ))}
        </div>

        {/* Destinations. */}
        <div className="flex flex-row gap-2 sm:flex-col">
          {dests.map((d) => (
            <span
              key={d.label}
              className="ps-arrive rounded-[6px] border border-white/10 bg-white/[0.05] px-3 py-2 font-mono text-white/75 text-[11.5px]"
              style={{ animationDelay: `${d.delay}s` }}
            >
              {d.label}
            </span>
          ))}
        </div>
      </div>

      <p className="mt-4 font-mono text-white/40 text-[10.5px]">
        durable · signed · retried · dead-lettered
      </p>
    </div>
  );
}

function PsLoop() {
  return (
    <section className="relative border-[#f6483826] border-t">
      <Container className="pt-16 pb-28">
        <Reveal>
          <Eyebrow>PostHog, when you want it</Eyebrow>
          <h2
            className={cn(
              "mt-8 max-w-[820px] font-normal text-[34px] leading-[1.15] tracking-[-0.01em] md:text-[48px] md:leading-[56px]",
              DISPLAY,
            )}
          >
            <span className="text-white">
              Plug it in and Hogsend makes it better.
            </span>{" "}
            <span className="text-white/40">
              Leave it out and the lifecycle still runs.
            </span>
          </h2>
        </Reveal>

        <div className="mt-14 grid grid-cols-1 gap-12 lg:grid-cols-2">
          <div className="flex flex-col">
            {LOOP_ITEMS.map((item, i) => (
              <div
                key={item.title}
                className={cn("py-5", i > 0 && "border-white/10 border-t")}
              >
                <h3 className="flex items-center gap-3 font-medium text-white text-[15px] tracking-[-0.02em]">
                  <span
                    aria-hidden="true"
                    className="size-2 shrink-0 bg-[#f64838]"
                  />
                  {item.title}
                </h3>
                <p className="mt-1.5 pl-5 text-white/55 text-sm leading-[21px] tracking-[-0.02em]">
                  {item.body}
                </p>
              </div>
            ))}
          </div>

          {/* The first-party tracking loop, animated. */}
          <Reveal delay={0.1} className="self-center">
            <PsTrackingAnimation />
          </Reveal>
        </div>
      </Container>
    </section>
  );
}

/* ------------------------------------------------------------------ repo -- */

const LESSONS = [
  {
    label: "Version control",
    title: "Every change has a history",
    body: "Every template and journey has a git history. What the welcome email said in March is one git log away, with who changed it and why.",
  },
  {
    label: "Code review",
    title: "The same pull request as everything else",
    body: "A journey ships through the same pull request as the rest of your product. Nothing goes live because someone clicked Save.",
  },
  {
    label: "Experiments",
    title: "Finished tests stay on the record",
    body: "Variants are code, so finished A/B tests stay in history — the losing copy, the reasoning, the result.",
  },
  {
    label: "Automation",
    title: "A dozen lines instead of a canvas",
    body: "A canvas flow is forty drag-and-drops; the same logic is a dozen lines of TypeScript that fit in a diff.",
  },
  {
    label: "Time to ship",
    title: "The work starts at editing",
    body: "The scaffold puts 10 journeys and 13 templates in your repo with one command. The work starts at editing, not building.",
  },
  {
    label: "Cost",
    title: "Costs scale with infrastructure",
    body: "Self-hosted software costs the same at 50,000 contacts as at 500. Costs scale with your infrastructure, not your list.",
  },
];

function PsRepo() {
  return (
    <section className="relative border-[#f6483826] border-t">
      <Container className="relative pt-16 pb-24">
        <PlusGrid className="top-12 right-0 hidden h-40 w-64 [mask-image:linear-gradient(to_left,black,transparent)] lg:block" />
        <Reveal>
          <Eyebrow>Why a repo</Eyebrow>
          <h2
            className={cn(
              "mt-8 max-w-[820px] font-normal text-[34px] leading-[1.15] tracking-[-0.01em] md:text-[48px] md:leading-[56px]",
              DISPLAY,
            )}
          >
            <span className="text-white">What the repo gives you.</span>{" "}
            <span className="text-white/40">
              The habits that make software dependable.
            </span>
          </h2>
        </Reveal>
        <div className="mt-12 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {LESSONS.map((lesson, i) => (
            <Reveal key={lesson.label} delay={(i % 3) * 0.06}>
              <div className="flex h-full flex-col rounded-lg border border-white/10 bg-white/[0.03] p-6">
                <span className="font-mono text-[#f64838] text-[11px] uppercase tracking-[0.08em]">
                  {lesson.label}
                </span>
                <h3 className="mt-3 font-medium text-white text-[15px] tracking-[-0.02em]">
                  {lesson.title}
                </h3>
                <p className="mt-2 text-white/55 text-sm leading-[21px] tracking-[-0.02em]">
                  {lesson.body}
                </p>
              </div>
            </Reveal>
          ))}
        </div>
      </Container>
    </section>
  );
}

/* --------------------------------------------------------------- hatchet -- */

const HATCHET_PILLARS = [
  {
    title: "Survives deploys & restarts",
    body: "A long ctx.sleep keeps running across a deploy and resumes days later, exactly where it left off.",
  },
  {
    title: "Automatic retries & timeouts",
    body: "Failed steps retry and waits expire on their own — durability you don't have to hand-roll.",
  },
  {
    title: "Self-host it, or use Hatchet Cloud",
    body: "Run Hatchet-Lite next to your app, or point at Hatchet Cloud. Same engine either way.",
  },
];

function PsHatchet() {
  return (
    <section className="relative">
      <Container className="py-20">
        <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-[#0a0606] p-8 text-white md:p-12">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                "radial-gradient(60% 80% at 100% 10%, rgba(246,72,56,0.18), rgba(246,72,56,0.04) 45%, transparent 70%)",
            }}
          />
          <WaveLines
            className="absolute bottom-0 left-0 h-48 w-[55%] opacity-50"
            stroke="rgba(246,72,56,0.4)"
            count={6}
          />
          <div className="relative">
            <BrandLogo brand="hatchet" height={32} className="text-white" />
            <Eyebrow light className="mt-8">
              Powered by Hatchet
            </Eyebrow>
            <h2
              className={cn(
                "mt-6 max-w-[640px] font-normal text-[34px] text-white leading-[1.15] tracking-[-0.01em] md:text-[44px] md:leading-[50px]",
                DISPLAY,
              )}
            >
              Durable execution, by Hatchet.
            </h2>
            <p className="mt-5 max-w-[640px] text-sm text-white/60 leading-[22px] tracking-[-0.02em]">
              Every journey runs on{" "}
              <a
                href="https://hatchet.run"
                target="_blank"
                rel="noreferrer"
                className="text-white underline decoration-white/30 underline-offset-4"
              >
                Hatchet
              </a>
              , the durable execution engine underneath Hogsend. It's what lets
              a long ctx.sleep survive a deploy and resume two days later
              exactly where it left off. Hogsend builds on Hatchet rather than
              rolling its own durability.
            </p>
            <div className="mt-10 grid grid-cols-1 gap-4 md:grid-cols-3">
              {HATCHET_PILLARS.map((pillar) => (
                <div
                  key={pillar.title}
                  className="rounded-lg border border-white/10 bg-white/[0.02] p-5"
                >
                  <h3 className="font-medium text-[15px] text-white tracking-[-0.02em]">
                    {pillar.title}
                  </h3>
                  <p className="mt-2 text-sm text-white/55 leading-[21px] tracking-[-0.02em]">
                    {pillar.body}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Container>
    </section>
  );
}

/* -------------------------------------------------------------- economics -- */

const RENT_MODELS: {
  name: string;
  model: string;
  rows: { key: string; value: string }[];
}[] = [
  {
    name: "Loops",
    model: "Subscribed contacts",
    rows: [
      { key: "5,000 contacts", value: "$49/mo*" },
      { key: "50,000 contacts", value: "$249/mo*" },
      { key: "Sending", value: "their infrastructure" },
      { key: "Grows with", value: "your list" },
    ],
  },
  {
    name: "Customer.io",
    model: "Profiles + emails + credits",
    rows: [
      { key: "Billing", value: "per profile + volume" },
      { key: "At scale", value: "custom pricing" },
      { key: "Sending", value: "their infrastructure" },
      { key: "Grows with", value: "your list" },
    ],
  },
  {
    name: "PostHog Workflows",
    model: "Per message sent",
    rows: [
      { key: "Free tier", value: "10k msgs/mo*" },
      { key: "After that", value: "$0.003/send*" },
      { key: "Sending", value: "managed sender" },
      { key: "Grows with", value: "send volume" },
    ],
  },
];

function PsEconomics() {
  return (
    <section className="relative border-[#f6483826] border-t">
      <Container className="pt-16 pb-28">
        <Reveal>
          <Eyebrow>Economics</Eyebrow>
          <h2
            className={cn(
              "mt-8 max-w-[820px] font-normal text-[34px] leading-[1.15] tracking-[-0.01em] md:text-[48px] md:leading-[56px]",
              DISPLAY,
            )}
          >
            <span className="text-white">What it costs.</span>{" "}
            <span className="text-white/40">
              Contact count appears in neither bill.
            </span>
          </h2>
          <p className="mt-6 max-w-[620px] text-white/55 text-base leading-[24px] tracking-[-0.02em]">
            There is no paid tier. You pay for hosting — the Railway template
            provisions Postgres, Redis, Hatchet, the API, and the worker — and
            for your own Resend or Postmark account.
          </p>
        </Reveal>

        <div className="mt-12 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {/* Hogsend — the highlighted card, detail rows pinned bottom. */}
          <Reveal className="h-full">
            <div className="relative flex h-full flex-col justify-between overflow-hidden rounded-lg border border-[#f64838]/40 bg-[#f64838]/[0.08] p-6">
              <span
                aria-hidden="true"
                className="absolute top-2 right-2 size-[10px] bg-[#f64838]"
              />
              <div>
                <span className="font-mono text-[#f64838] text-[11px] uppercase tracking-[0.08em]">
                  Hogsend
                </span>
                <span
                  className={cn(
                    "mt-3 block text-white text-[24px] leading-[1.15] tracking-[-0.02em]",
                    DISPLAY,
                  )}
                >
                  Self-hosted · $0 software
                </span>
              </div>
              <div className="mt-6 flex flex-col">
                {[
                  { key: "Software", value: "$0, ELv2" },
                  { key: "Hosting", value: "your infrastructure" },
                  { key: "Sending", value: "your Resend / Postmark" },
                  { key: "Per contact", value: "nothing" },
                ].map((row, i) => (
                  <div
                    key={row.key}
                    className={cn(
                      "flex items-baseline justify-between gap-3 py-2",
                      i > 0 && "border-[#f64838]/15 border-t",
                    )}
                  >
                    <span className="font-mono text-white/45 text-[11px]">
                      {row.key}
                    </span>
                    <span className="text-right font-medium text-white text-[13px] tracking-[-0.02em]">
                      {row.value}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </Reveal>
          {RENT_MODELS.map((m, i) => (
            <Reveal key={m.name} delay={(i + 1) * 0.06} className="h-full">
              <div className="flex h-full flex-col justify-between rounded-lg border border-white/10 bg-white/[0.03] p-6">
                <div>
                  <span className="font-mono text-white/40 text-[11px] uppercase tracking-[0.08em]">
                    {m.name}
                  </span>
                  <span
                    className={cn(
                      "mt-3 block text-white/75 text-[20px] leading-[1.2] tracking-[-0.02em]",
                      DISPLAY,
                    )}
                  >
                    {m.model}
                  </span>
                </div>
                <div className="mt-6 flex flex-col">
                  {m.rows.map((row, j) => (
                    <div
                      key={row.key}
                      className={cn(
                        "flex items-baseline justify-between gap-3 py-2",
                        j > 0 && "border-white/10 border-t",
                      )}
                    >
                      <span className="font-mono text-white/40 text-[11px]">
                        {row.key}
                      </span>
                      <span className="text-right text-white/75 text-[13px] tracking-[-0.02em]">
                        {row.value}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </Reveal>
          ))}
        </div>
        <p className="mt-6 text-white/40 text-[12px] tracking-[-0.02em]">
          *Published pricing, checked July 2026.
        </p>
      </Container>
    </section>
  );
}

/* ------------------------------------------------------------- use cases -- */

const USE_CASES = [
  {
    title: "Welcome / onboarding",
    body: "Greet people the moment they sign up, then branch on whether they've actually tried anything yet.",
    href: "/use-cases/onboarding",
  },
  {
    title: "Activation nudge",
    body: "Drive the one action most correlated with sticking around — before the trial clock runs out.",
    href: "/recipes/category/onboarding",
  },
  {
    title: "Feature adoption",
    body: "Most churn is a feature users never found. Surface the one they're missing.",
    href: "/recipes/category/onboarding",
  },
  {
    title: "Trials that convert",
    body: "Match the ask to how much they've really used, not the day on the calendar.",
    href: "/use-cases/trial-conversion",
  },
  {
    title: "Payment saves",
    body: "Involuntary churn is the biggest leak you can plug. Remind, and stop the moment it clears.",
    href: "/recipes/category/conversion",
  },
  {
    title: "Win-backs",
    body: "You already paid to acquire them once — winning them back costs a fraction of a new signup.",
    href: "/use-cases/winback",
  },
  {
    title: "Milestones",
    body: "Celebrate progress and reinforce the habit at the moments value actually lands.",
    href: "/recipes/category/retention",
  },
  {
    title: "Referrals",
    body: "Ask for the referral at the moment value lands, when they're most likely to say yes.",
    href: "/recipes",
  },
];

/** The four full landers, surfaced. Descriptions are the nav mega-panel's. */
const USE_CASE_DEEP_DIVES = [
  {
    title: "Onboarding",
    body: "Welcome flows that branch on what new users actually do.",
    href: "/use-cases/onboarding",
  },
  {
    title: "Trial conversion",
    body: "Usage-driven nudges that stop the moment they pay.",
    href: "/use-cases/trial-conversion",
  },
  {
    title: "Win-back",
    body: "Spot who's gone quiet and bring them back.",
    href: "/use-cases/winback",
  },
  {
    title: "Community",
    body: "Read Discord activity off the same contact as your product.",
    href: "/use-cases/community",
  },
];

function PsUseCases() {
  return (
    <section id="use-cases" className="relative border-[#f6483826] border-t">
      <Container className="pt-16 pb-28">
        <Eyebrow>Use cases</Eyebrow>
        <h2
          className={cn(
            "mt-8 max-w-[760px] font-normal text-[34px] leading-[1.15] tracking-[-0.01em] md:text-[48px] md:leading-[56px]",
            DISPLAY,
          )}
        >
          <span className="text-white">
            The messages every product should send
          </span>{" "}
          <span className="text-white/40">
            — ten journeys ship in the scaffold.
          </span>
        </h2>

        {/* The event-fanning card idiom: tinted panels, lead + gray rest —
            each card now links to the lander or recipe category that covers
            it. */}
        <div className="mt-14 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {USE_CASES.map((u, i) => (
            <Link
              key={u.title}
              href={u.href}
              className="group p-6 transition-colors hover:bg-white/[0.07]"
              style={{
                background:
                  i % 2 === 0
                    ? "rgba(255,255,255,0.04)"
                    : "rgba(246,72,56,0.07)",
              }}
            >
              <p className="text-[14.5px] leading-[22px] tracking-[-0.02em]">
                <span className="font-medium text-white">{u.title}.</span>{" "}
                <span className="text-white/55">{u.body}</span>{" "}
                <span
                  aria-hidden="true"
                  className="text-white/40 transition-colors group-hover:text-white"
                >
                  →
                </span>
              </p>
            </Link>
          ))}
        </div>

        {/* The four deep-dive landers — full pages, one per use case. */}
        <div className="mt-14 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {USE_CASE_DEEP_DIVES.map((d) => (
            <Link
              key={d.href}
              href={d.href}
              className="group rounded-[6px] border border-white/10 p-6 transition-colors hover:border-[#f64838]/60"
            >
              <span className="font-mono text-[11px] text-white/40 uppercase tracking-[0.08em]">
                Deep dive
              </span>
              <h3 className="mt-2 font-medium text-base text-white tracking-[-0.025em]">
                {d.title}{" "}
                <span
                  aria-hidden="true"
                  className="text-white/40 transition-colors group-hover:text-[#f64838]"
                >
                  →
                </span>
              </h3>
              <p className="mt-1.5 text-sm text-white/55 leading-[21px] tracking-[-0.02em]">
                {d.body}
              </p>
            </Link>
          ))}
        </div>

        <p className="mt-10 text-sm text-white/55 tracking-[-0.02em]">
          Every journey here sends one of{" "}
          <Link href="/emails" className="font-medium text-white">
            13 React Email templates in the scaffold →
          </Link>{" "}
          <span className="text-white/30">·</span> copy-paste variants for all
          of these live in the{" "}
          <Link href="/recipes" className="font-medium text-white">
            35-recipe cookbook →
          </Link>
        </p>
      </Container>
    </section>
  );
}

/* ------------------------------------------------------------------ faq -- */

const FAQ = [
  {
    q: "Is Hogsend open source?",
    a: "Hogsend is source-available under the Elastic License 2.0 (ELv2). You can read, modify, and self-host all of it for free; the only restriction is offering Hogsend itself as a managed service.",
  },
  {
    q: "What does Hogsend cost?",
    a: "The software is free — there is no paid tier. You self-host and pay only your own infrastructure plus your Resend or Postmark account. No per-contact, per-profile, or per-send fees.",
  },
  {
    q: "How is Hogsend different from PostHog Workflows?",
    a: "Workflows is PostHog's built-in no-code canvas with a managed sender. Hogsend is typed TypeScript in your repo with durable waits, behavioral branching, and your own email provider — for when lifecycle logic outgrows boxes and arrows.",
  },
  {
    q: "Does Hogsend replace Resend or use it?",
    a: "It uses it. Hogsend is the orchestration layer — journeys, segments, suppression, tracking — and sends through your own Resend account by default, with Postmark as a one-env-var swap. Resend's own Automations cover simple dashboard-built sequences; Hogsend is for when the logic belongs in your repo — event-triggered, type-checked, and portable across providers.",
  },
  {
    q: "Do I need PostHog to use Hogsend?",
    a: "No. Send first-party events directly with @hogsend/js or the Data API, use signed webhook presets for Stripe, Clerk, Supabase, or Segment, or define any custom source. PostHog is a first-class optional integration.",
  },
  {
    q: "Will my emails survive a deploy mid-journey?",
    a: "Yes. Journeys run as Hatchet durable tasks: a user three days into a seven-day wait keeps waiting through deploys, restarts, and crashes, and resumes exactly where they were.",
  },
  {
    q: "Can AI agents write Hogsend journeys?",
    a: "Yes — journeys are plain TypeScript files, so coding agents can read your product events and types, write or modify a journey, and leave you a reviewable diff. Your type-checker validates it before it ships.",
  },
];

// FAQPage structured data mirrors the visible FAQ copy verbatim (it reads
// from the same FAQ array the accordion renders).
const faqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: FAQ.map((item) => ({
    "@type": "Question",
    name: item.q,
    acceptedAnswer: {
      "@type": "Answer",
      text: item.a,
    },
  })),
};

function PsFaq() {
  return (
    <section className="relative border-[#f6483826] border-t">
      <Container className="grid grid-cols-1 gap-12 pt-16 pb-32 lg:grid-cols-[1fr_1.5fr]">
        {/* Flint's FAQ layout: the heading floats on a soft aura blob. */}
        <div className="relative">
          <div
            aria-hidden="true"
            className="-inset-x-12 -inset-y-16 pointer-events-none absolute"
            style={{
              background:
                "radial-gradient(45% 45% at 40% 35%, rgba(253,220,180,0.14), transparent 70%), radial-gradient(40% 45% at 65% 65%, rgba(246,72,56,0.18), transparent 70%), radial-gradient(30% 35% at 30% 75%, rgba(246,140,110,0.12), transparent 70%)",
              filter: "blur(28px)",
            }}
          />
          <div className="relative lg:sticky lg:top-28">
            <Eyebrow>FAQ</Eyebrow>
            <h2
              className={cn(
                "mt-8 font-normal text-[34px] leading-[1.15] tracking-[-0.01em] md:text-[48px]",
                DISPLAY,
              )}
            >
              <span className="text-white">Find what you need</span>
              <span className="text-white/40">.</span>
            </h2>
          </div>
        </div>

        <div>
          {FAQ.map((item, i) => (
            <details
              key={item.q}
              className={cn(
                "group border-white/10 border-b",
                i === 0 && "border-t",
              )}
            >
              <summary className="flex cursor-pointer list-none items-center justify-between gap-6 py-6 [&::-webkit-details-marker]:hidden">
                <span className="font-medium text-white text-base tracking-[-0.025em] md:text-lg">
                  {item.q}
                </span>
                <span
                  aria-hidden="true"
                  className="shrink-0 text-white/40 text-xl transition-transform group-open:rotate-45"
                >
                  +
                </span>
              </summary>
              <p className="max-w-[820px] pb-6 text-white/55 text-base leading-[24px] tracking-[-0.02em]">
                {item.a}
              </p>
            </details>
          ))}
        </div>
      </Container>
    </section>
  );
}

/* ------------------------------------------------------------ closing CTA -- */

function PsClosingCta() {
  return (
    <section className="relative">
      <Container className="py-20">
        <div className="relative overflow-hidden rounded-2xl bg-[#070303]">
          {/* Red glow bleeding in from the left edge — the crimzon card. */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                "radial-gradient(70% 100% at 0% 60%, rgba(246,72,56,0.3), rgba(246,72,56,0.08) 45%, transparent 70%)",
            }}
          />
          <WaveLines
            className="absolute inset-y-0 right-0 h-full w-[58%] opacity-70"
            stroke="rgba(255,140,118,0.4)"
            count={9}
          />
          <div className="relative p-8 md:p-14">
            <Eyebrow light>Get started</Eyebrow>
            <h2
              className={cn(
                "max-w-[640px] font-normal text-[36px] text-white leading-[1.15] tracking-[-0.02em] md:text-[48px] md:leading-[56px]",
                DISPLAY,
              )}
            >
              First send in minutes.
            </h2>
            <p className="mt-5 max-w-[560px] text-sm text-white/60 leading-[22px] tracking-[-0.02em]">
              The scaffold command sets up the app, Docker, env, and ten
              journeys — the welcome series included. pnpm bootstrap brings the
              stack up. Or deploy the Railway template in a click.
            </p>

            {/* Every line a fact. */}
            <ul className="mt-8 flex flex-col gap-2.5">
              {[
                "Free to self-host · source-available under ELv2",
                "Ten journeys in the scaffold, welcome series included",
                "Sends through your own Resend or Postmark account",
                "One-click Railway template, 3 required env vars",
              ].map((line) => (
                <li
                  key={line}
                  className="flex items-center gap-3 text-[15px] text-white/80 tracking-[-0.02em]"
                >
                  <span
                    aria-hidden="true"
                    className="inline-flex size-5 shrink-0 items-center justify-center rounded-full border border-white/25 text-[11px] text-white/80"
                  >
                    ✓
                  </span>
                  {line}
                </li>
              ))}
            </ul>

            <div className="mt-10 flex flex-wrap items-center gap-4">
              <Btn href="/docs/getting-started" size="lg">
                Start building
              </Btn>
              <Btn href={RAILWAY_DEPLOY_URL} variant="outline" size="lg">
                Deploy on Railway
              </Btn>
              <span className="flex items-center gap-3 rounded-[6px] border border-white/10 bg-white/[0.04] py-3 pr-3 pl-4">
                <code className="font-mono text-[12.5px] text-white/90">
                  <span className="text-[#f6907f]">$ </span>
                  {INSTALL_COMMAND}
                </code>
                <CopyButton value={INSTALL_COMMAND} />
              </span>
            </div>
          </div>
        </div>
      </Container>
    </section>
  );
}

/* --------------------------------------------------------------- footer -- */

const FOOTER_COLS: {
  title: string;
  links: { label: string; href: string }[];
}[] = [
  {
    title: "Product",
    links: [
      { label: "Done-for-you setup", href: "/service" },
      { label: "Course", href: "https://course.hogsend.com" },
      { label: "Paid acquisition", href: "/paid" },
      { label: "Campaigns", href: "/campaigns" },
      { label: "Growth", href: "/growth-metrics" },
      { label: "Pricing", href: "/pricing" },
      { label: "Templates", href: "/emails" },
      { label: "Integrations", href: "/integrations" },
      { label: "Recipes", href: "/recipes" },
      { label: "Studio", href: "/docs/operating/studio" },
      { label: "Changelog", href: "/changelog" },
    ],
  },
  {
    title: "Use cases",
    links: [
      { label: "Onboarding", href: "/use-cases/onboarding" },
      { label: "Trial conversion", href: "/use-cases/trial-conversion" },
      { label: "Win-back", href: "/use-cases/winback" },
      { label: "Community", href: "/use-cases/community" },
      {
        label: "Transactional email",
        href: "/docs/recipes/transactional-emails",
      },
    ],
  },
  {
    title: "Compare",
    links: [
      {
        label: "vs PostHog Workflows",
        href: "/docs/compare/posthog-workflows",
      },
      { label: "vs Loops", href: "/docs/compare/loops" },
      { label: "vs Customer.io", href: "/docs/compare/customer-io" },
      { label: "vs Klaviyo", href: "/docs/compare/klaviyo" },
      { label: "Feature matrix", href: "/docs/compare/feature-matrix" },
      { label: "Migration guide", href: "/docs/compare/migration" },
    ],
  },
  {
    title: "Developers",
    links: [
      { label: "Docs", href: "/docs" },
      { label: "Getting started", href: "/docs/getting-started" },
      { label: "Data API", href: "/docs/data-api" },
      { label: "CLI", href: "/docs/cli" },
      { label: "API reference", href: "/docs/api" },
      { label: "llms.txt", href: "/llms.txt" },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "About", href: "/about" },
      { label: "GitHub", href: GITHUB_URL },
      { label: "npm", href: NPM_URL },
      { label: "Discord", href: "/discord" },
      { label: "License", href: "/pricing#license" },
      { label: "Privacy", href: "/privacy" },
      { label: "Terms", href: "/terms" },
    ],
  },
];

function PsFooter() {
  return (
    <footer className="border-white/10 border-t bg-[#060608] text-white">
      <Container className="grid grid-cols-1 gap-14 py-20 lg:grid-cols-[1.2fr_2fr]">
        <div>
          <InkLogo light />
          <p className="mt-6 text-sm text-white/60 tracking-[-0.02em]">
            Lifecycle automation, in code
          </p>
          <p className="mt-2 text-sm text-white/40 tracking-[-0.02em]">
            © 2026 Hogsend. All rights reserved.
          </p>
          <CookieSettingsLink className="mt-2 text-sm text-white/40 tracking-[-0.02em] transition-colors hover:text-white" />
        </div>
        <div className="grid grid-cols-2 gap-10 md:grid-cols-5">
          {FOOTER_COLS.map((col) => (
            <div key={col.title}>
              <p className="font-medium text-sm text-white tracking-[-0.02em]">
                {col.title}
              </p>
              <ul className="mt-4 space-y-2.5">
                {col.links.map((l) => (
                  <li key={l.label}>
                    <Link
                      href={l.href}
                      className="text-sm text-white/60 tracking-[-0.02em] hover:text-white"
                    >
                      {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Container>
    </footer>
  );
}

/** Full-height vertical hairlines at the content-frame edges — the crimzon
 * PageFrame idiom, re-keyed to a light red-tint rule. */
function PsFrame() {
  return (
    <div
      aria-hidden="true"
      className="-translate-x-1/2 pointer-events-none fixed inset-y-0 left-1/2 z-40 hidden w-full max-w-[1256px] border-[#f6483826] border-x lg:block"
    />
  );
}

/* ----------------------------------------------------------------- page -- */

export default async function HomePage(): Promise<JSX.Element> {
  const engineVersion = await getEngineVersion();
  return (
    <main className="overflow-x-clip tracking-normal">
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: static JSON-LD built from our own constants
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />
      {/* Notification bar (the live "chat to Doug" ticker) — shared with the
          interior pages; sits above the sticky nav and scrolls away with it. */}
      <AnnouncementBanner />
      <PsNav />
      <PsHero engineVersion={engineVersion} />
      <PsProofStrip />
      <PsProblem />
      {/* Temporarily hidden: <_PsHowItWorks /> */}
      <PsCode />
      <PsAgents />
      <PsUseCases />
      <PsProductDemo />
      <PsPlaybook />
      <PsFanning />
      {/* Temporarily hidden: <_PsStats /> */}
      <PsRepo />
      <PsElephant />
      <PsSetup />
      <PsCorePlatform />
      <PsBuildingBlocks />
      <PsPlatformPitch />
      <PsOpen />
      <PsFeatures />
      <PsStudioDemo />
      <PsLoop />
      <PsHatchet />
      <PsEconomics />
      <PsFaq />
      <PsClosingCta />
      <PsFooter />
      <PsFrame />
    </main>
  );
}
