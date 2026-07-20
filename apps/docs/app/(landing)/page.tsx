import { Mail, MessageSquare, Zap } from "lucide-react";
import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import QRCode from "qrcode";
import type { JSX, ReactNode } from "react";
import {
  fieldInitialHour,
  LANDSCAPE_FIELD,
  MATCHDAY_FIELD,
} from "@/app/spike-daylight/field-config";
import { DayfieldHeroSection } from "@/app/spike-daylight/landing/landing-hero";
import { TrackDemoClick } from "@/components/analytics/track";
import { AnnouncementBanner } from "@/components/announcement-banner";
import { CookieSettingsLink } from "@/components/consent/cookie-settings-link";
import { type BrandKey, BrandLogo } from "@/components/ds/brand-logo";
import { CodeHighlight } from "@/components/ds/code-highlight";
import { CopyButton } from "@/components/ds/copy-button";
import { LogoMarquee } from "@/components/ds/marquee";
import { Reveal } from "@/components/ds/reveal";
import {
  HalftoneOverlay,
  ThermalCard,
  ThermalHover,
  ThermalLayer,
} from "@/components/ds/thermal";
import { isHogsendConfigured } from "@/components/hogsend/config";
import { ManifestoVideo } from "@/components/hogsend/manifesto-video";
import { InAppDemoBody } from "@/components/landing/in-app-demo-body";
import { cn } from "@/lib/cn";
import { getEngineVersion } from "@/lib/engine-version";
import { DEMO_URL, GITHUB_URL, NPM_URL } from "@/lib/site";
import postphant from "@/public/images/postphant.png";
import studioOverview from "@/public/images/studio/02-overview-dashboard.png";
import studioEvents from "@/public/images/studio/03-events-ingestion.png";
import studioSends from "@/public/images/studio/04-sends-history.png";
import studioTemplates from "@/public/images/studio/05-templates-catalog.png";
import studioLinks from "@/public/images/studio/06-links-tracking.png";
import studioCampaigns from "@/public/images/studio/07-campaigns-list.png";
import studioJourneys from "@/public/images/studio/08-journeys-overview.png";
import studioBuckets from "@/public/images/studio/09-buckets-audiences.png";
import { AgentPromptLoop } from "./_components/agent-prompt-loop";
import { PsBlocksTabs } from "./_components/blocks-tabs";
import { InkLogo } from "./_components/brand";
import {
  type ProviderValue,
  PsCodePicker,
  type UseCaseValue,
} from "./_components/code-picker";
import { DiscordLinkCard } from "./_components/discord-link-card";
import { EmailAnswersCard } from "./_components/email-answers-card";
import { FlagPersonaSwitcher } from "./_components/flag-persona-switcher";
import { ImpactReadout } from "./_components/impact-readout";
import { MINTED_FILES } from "./_components/minted-files";
import { PsNav } from "./_components/nav";
import { PsFrame } from "./_components/page-frame";
import { QrLinksCard } from "./_components/qr-links-card";
import { ScaffoldExplorer } from "./_components/scaffold-explorer";
import { SCAFFOLD_FILES } from "./_components/scaffold-files";
import { StudioGallery, type StudioShot } from "./_components/studio-gallery";
import { TimingCard } from "./_components/timing-card";
import { WiredHeroSection } from "./_components/wired-hero";
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
    "Lifecycle automation in TypeScript for growth engineering teams and their agents. Build onboarding, conversion, retention, and win-back journeys in your repo — with or without PostHog.",
  alternates: { canonical: "/" },
  keywords: [
    "lifecycle automation framework",
    "product-led growth",
    "growth engineering",
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
// The homepage hero swaps to the match-day stadium on this date (the World Cup
// final), keyed to the event's New-York timezone. ISO YYYY-MM-DD.
const WORLD_CUP_FINAL_DATE = "2026-07-19";
const AGENT_CLOSING_PROMPT =
  "Visit hogsend.com/docs and implement lifecycle marketing for our product — start with the welcome series.";

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
        "inline-flex items-center gap-2 rounded-full border border-[var(--tw-border)] bg-white/[0.03] px-3.5 py-1.5 font-mono text-[11px] uppercase tracking-[0.08em]",
        light ? "text-white/80" : "text-white/90",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="h-[7px] w-[7px] rounded-full"
        style={{
          background: "linear-gradient(135deg, #ffb187 0%, #f64838 100%)",
        }}
      />
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
        "inline-flex items-center justify-center rounded-full font-medium tracking-[-0.025em] transition-colors",
        size === "sm" ? "px-4.5 py-2 text-sm" : "px-6 py-3.5 text-base",
        variant === "solid" && "bg-white text-[#0a0a0a] hover:bg-white/90",
        variant === "outline" &&
          "border border-[var(--tw-border)] text-white hover:bg-white/[0.06]",
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
          "url(\"data:image/svg+xml,%3Csvg width='28' height='28' viewBox='0 0 28 28' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M14 10v8M10 14h8' stroke='%23bfa0ff' stroke-opacity='0.22' stroke-width='1'/%3E%3C/svg%3E\")",
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
          "radial-gradient(rgba(190,160,255,0.38) 1.2px, transparent 1.2px)",
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
        <div className="mt-6 flex items-center gap-2 rounded-[6px] border border-[var(--tw-border)] p-1.5 pl-4">
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
              className="ps-feed-in rounded-md border border-[var(--tw-border)] bg-white/[0.04] px-4 py-3"
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
            className="ps-feed-in rounded-md border border-[var(--tw-border)] bg-white/[0.04] px-4 py-3"
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
                  <span className="rounded-full border border-[var(--tw-border)] px-3 py-1 font-medium text-white/55 text-[12px]">
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
      {/* Subtle backdrop — the crimzon horizon glow from the original hero,
       * dialed way down so copy stays legible. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-40 mix-blend-screen"
        style={{
          background:
            "radial-gradient(90% 60% at 50% 115%, rgba(246,72,56,0.28) 0%, rgba(246,72,56,0.1) 45%, transparent 75%)",
        }}
      />
      {/* Generated thermal smoke morphing behind the copy, halftone riding
          only where it glows. */}
      <ThermalLayer strength={0.17} />
      <HalftoneOverlay className="opacity-40" />
      <Container className="relative flex min-h-[46vh] flex-col items-center pt-14 text-center md:min-h-[60vh] md:pt-24">
        <div className="flex w-full flex-col items-center">
          <div className="flex flex-col items-center">
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
          </div>

          <div className="flex flex-col items-center mt-6 md:mt-9">
            <h1
              className={cn(
                "max-w-[800px] text-balance font-normal text-white text-[36px] leading-[1.08] tracking-[-0.02em] md:text-[64px] md:leading-[68px]",
                DISPLAY,
              )}
            >
              Your customer lifecycle belongs in your repo.
            </h1>
          </div>

          <div className="flex flex-col items-center mt-4 md:mt-6">
            <p className="max-w-[680px] text-white/75 text-base leading-[24px] tracking-[-0.025em] md:text-lg md:leading-[27px]">
              Hogsend is the lifecycle automation framework for growth
              engineering teams — and their agents — that ship code-first.
              Journeys live in your repo, reviewed and versioned like the rest
              of your product.
            </p>
          </div>

          {/* Primary path: scaffold in one command. */}
          <div className="flex flex-col items-center mt-6 gap-3 md:mt-8">
            <ThermalHover>
              <span className="flex min-w-0 items-center gap-2 rounded-[6px] border border-white/15 bg-white/[0.03] py-2 pr-2 pl-4">
                <code className="min-w-0 overflow-x-auto whitespace-nowrap font-mono text-[13px] text-white/90 [scrollbar-width:none]">
                  <span className="text-white/40">$ </span>
                  {INSTALL_COMMAND}
                </code>
                <CopyButton
                  value={INSTALL_COMMAND}
                  className="shrink-0 text-white/40 hover:text-white"
                />
              </span>
            </ThermalHover>
          </div>

          {/* The Flint prompt-card idiom: an agent ask, sitting on a soft
              two-colour blob glow. */}
          <div className="flex flex-col items-center mt-8 w-full max-w-[620px] md:mt-12">
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
              <ThermalHover rounded="rounded-xl">
                <AgentPromptLoop engineVersion={engineVersion} />
              </ThermalHover>
            </div>
          </div>

          <div className="flex flex-col items-center mt-4 md:mt-5">
            <p className="max-w-[760px] font-mono text-[12px] text-white/45 uppercase leading-5 tracking-[0.06em]">
              Onboarding · Trial conversion · Payment recovery · Retention ·
              Win-back · Across email, in-app, SMS, Discord, and more
            </p>
          </div>
        </div>
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
    <section className="relative overflow-hidden tw-section">
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

      {/* Twilight-halftone horizon, full-bleed — the closing-CTA treatment
          Doug loves (halftone dots + a glow that reads warm against the
          purple ground), swapped in for the old hard-red planet. */}
      <div className="relative mt-12 h-[300px] md:h-[340px]">
        {/* Thermal smoke bed under the horizon glow. */}
        <ThermalLayer strength={0.3} />
        <HalftoneOverlay className="opacity-45" />
        <div
          aria-hidden="true"
          className="absolute inset-0 mix-blend-screen"
          style={{
            background:
              "radial-gradient(72% 72% at 50% 118%, rgba(190,150,255,0.42) 0%, rgba(255,150,128,0.3) 38%, rgba(190,150,255,0.08) 66%, transparent 82%)",
          }}
        />
        {/* The crisp horizon arc — warm peach, softened. */}
        <div
          aria-hidden="true"
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(52% 46% at 50% 116%, transparent 59%, rgba(255,168,132,0.7) 61.5%, rgba(255,168,132,0.1) 66%, transparent 71%)",
          }}
        />
      </div>

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
          Open Source
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

/* -------------------------------------------------------------- problem -- */

const PILLARS = [
  {
    title: "Journeys as code",
    body: "Lifecycle logic is TypeScript in your repo, reviewed, type-checked, and versioned like the rest of your product.",
  },
  {
    title: "Your provider, your reputation",
    body: "Sends go through your own Resend or Postmark account, or any provider behind the EmailProvider contract.",
  },
  {
    title: "Durable execution",
    body: "Journeys run as Hatchet durable tasks. A seven-day wait survives deploys, restarts, and crashes.",
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
    <span className="inline-flex size-[46px] items-center justify-center rounded-xl border border-[var(--tw-border)] bg-[var(--tw-card)]">
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

/** The old "pick a use case" and "timing primitives" sections, merged into
 * the explorer as quick-select recipe chips. Each opens a real file in the
 * scaffold — journeys, the backend API route, the React hooks. */
const EXPLORER_RECIPES = [
  { label: "Onboarding", path: "hogsend/src/journeys/product/onboarding.ts" },
  {
    label: "Trial conversion",
    path: "hogsend/src/journeys/billing/trial-conversion.ts",
  },
  { label: "Win-back", path: "hogsend/src/journeys/product/winback.ts" },
  { label: "Dunning", path: "hogsend/src/journeys/billing/dunning.ts" },
  {
    label: "Weekly digest + timing",
    path: "hogsend/src/journeys/product/weekly-digest.ts",
  },
  {
    label: "Discord summon",
    path: "hogsend/src/journeys/marketing/event-summon.ts",
  },
  {
    label: "Discord DM",
    path: "hogsend/src/journeys/lifecycle/discord-welcome.ts",
  },
  {
    label: "Telegram",
    path: "hogsend/src/journeys/lifecycle/telegram-nudge.ts",
  },
  { label: "SMS", path: "hogsend/src/journeys/lifecycle/cart-reminder.ts" },
  {
    label: "Slack approval",
    path: "hogsend/src/journeys/lifecycle/approval-gate.ts",
  },
  { label: "Experiments", path: "hogsend/src/journeys/product/experiments.ts" },
  { label: "Buckets", path: "hogsend/src/buckets/went-dormant.ts" },
  { label: "Flags", path: "hogsend/src/flags.ts" },
  { label: "Groups", path: "api/src/routes/groups.ts" },
  { label: "Destinations", path: "hogsend/src/destinations/crm.ts" },
  { label: "Webhook sources", path: "hogsend/src/webhook-sources/billing.ts" },
  { label: "Links & QR", path: "hogsend/scripts/event-qr.sh" },
  { label: "Broadcasts", path: "api/src/campaigns/march-launch.ts" },
  { label: "Backend API", path: "api/src/routes/signup.ts" },
  { label: "React hooks", path: "web/src/components/paywall.tsx" },
  { label: "Video", path: "web/src/components/lesson-player.tsx" },
  { label: "Agents & MCP", path: ".mcp.json" },
];

function PsProblem() {
  return (
    <section className="relative tw-section overflow-hidden">
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

        {/* The scaffolded app itself, floating over a soft gradient — file
            tree on the left, the clicked file's code on the right, and the
            rendered email in a corner window when a template is selected. */}
        <div className="relative mt-16">
          <div
            aria-hidden="true"
            className="absolute inset-x-0 top-12 bottom-0"
            style={{
              background:
                "linear-gradient(180deg, transparent 0%, rgba(190,150,255,0.14) 40%, rgba(255,170,130,0.16) 80%, transparent 100%)",
            }}
          />
          <ScaffoldExplorer
            files={SCAFFOLD_FILES.map(
              ({ path, email, timing, surface, note }) => ({
                path,
                email,
                timing,
                surface,
                note,
              }),
            )}
            recipes={EXPLORER_RECIPES}
            highlighted={Object.fromEntries(
              SCAFFOLD_FILES.map((f) => [
                f.path,
                <CodeHighlight key={f.path} code={f.source} lang={f.lang} />,
              ]),
            )}
          />
        </div>

        {/* Three line-icon pillars, Polar's under-screenshot feature row. */}
        <p className="mt-20 max-w-[420px] text-white text-lg leading-[26px] tracking-[-0.025em]">
          The lifecycle becomes part of the product, not a campaign bolted on
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

/* ------------------------------------------------------------ manifesto -- */

/** The "why now" manifesto quote — a big centered display statement, two-tone
 * (white lede → faint body), mirroring the use-case ProblemStatement block. */
function PsManifesto() {
  return (
    <section className="relative tw-section overflow-hidden">
      <PlusGrid className="top-16 left-0 hidden h-40 w-56 [mask-image:linear-gradient(to_right,black,transparent)] lg:block" />
      <Container className="relative pt-24 pb-24 md:pt-28 md:pb-28">
        <Reveal className="flex flex-col items-center text-center">
          <Eyebrow className="mb-8">Why now</Eyebrow>
          <p
            className={cn(
              "mx-auto max-w-[920px] font-normal text-[26px] leading-[36px] tracking-[-0.02em] md:text-[38px] md:leading-[50px]",
              DISPLAY,
            )}
          >
            <span className="text-white">
              Go-to-market is an engineering discipline now. The
              &ldquo;Marketing Engineer&rdquo; isn&rsquo;t a dirty word.
              It&rsquo;s the job.
            </span>{" "}
            <span className="text-white/40">
              Hogsend is ten years of product-led growth, handed to the scrappy
              teams who build it in code.
            </span>
          </p>
        </Reveal>
      </Container>
    </section>
  );
}

/* ---------------------------------------------------------------- video -- */

/** Hogsend Video — the player IS the product surface. The section holds the
 * @hogsend/video player with its live event-feed terminal (press play and the
 * simulated feed hands over to the real events), then names the facts:
 * monotonic watch depth, once-per-milestone progress events, one event shape
 * across providers, emitters that also write to PostHog/GA4. */
const VIDEO_PILLARS = [
  {
    title: "Depth that survives scrubbing",
    body: "percentWatched is the deepest point reached — monotonic, so skipping back and forth never inflates it.",
  },
  {
    title: "Milestones fire once",
    body: "video.progress lands a single event at 25, 50, 75, and 90 percent, alongside started, completed, and replay.",
  },
  {
    title: "One event shape, any player",
    body: "YouTube, Vimeo, and native <video> emit the same events, so journeys never care where the video lives.",
  },
  {
    title: "Emitters, not lock-in",
    body: "createHogsendEmitter feeds your journeys; the same interface writes to PostHog or GA4, or all of them combined.",
  },
];

function PsVideo() {
  return (
    // No top seam: the Feature index above is the header of everything below,
    // so the two read as one band rather than being split by a horizon line.
    <section id="video" className="relative overflow-hidden">
      <Container className="relative pt-16 pb-28">
        <Reveal>
          <Eyebrow>Hogsend Video</Eyebrow>
          <h2
            className={cn(
              "mt-8 max-w-[860px] font-normal text-[34px] leading-[1.15] tracking-[-0.01em] md:text-[48px] md:leading-[56px]",
              DISPLAY,
            )}
          >
            <span className="text-white">
              Every video becomes an event stream.
            </span>{" "}
            <span className="text-white/40">
              This player is @hogsend/video. Press play — the feed beside it is
              the events it captures.
            </span>
          </h2>
        </Reveal>

        <Reveal delay={0.1} className="block">
          <ManifestoVideo />
        </Reveal>

        <div className="mt-16 grid gap-x-10 gap-y-10 sm:grid-cols-2 lg:grid-cols-4">
          {VIDEO_PILLARS.map((p) => (
            <div key={p.title}>
              <h3 className="font-medium text-base text-white tracking-[-0.025em]">
                {p.title}
              </h3>
              <p className="mt-2 max-w-[300px] text-white/55 text-sm leading-[21px] tracking-[-0.02em]">
                {p.body}
              </p>
            </div>
          ))}
        </div>

        <div className="mt-12 flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-[640px] text-sm text-white/55 tracking-[-0.02em]">
            Watch depth is a journey trigger like any other event — the
            retargeting play in the playbook runs on it.
          </p>
          <Link
            href="/docs/client-side/video"
            className="font-medium text-sm text-white tracking-[-0.025em] hover:opacity-70"
          >
            Read the video docs →
          </Link>
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

function _PsStudioDemo() {
  return (
    <section id="live-demo" className="relative tw-section">
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
          <span className="flex items-center gap-3 rounded-[6px] border border-[var(--tw-border)] bg-white/[0.04] py-3 pr-3 pl-4">
            <code className="font-mono text-[12.5px] text-white/90">
              {DEMO_CREDENTIALS}
            </code>
            <CopyButton
              value="forgeline-demo-2026"
              className="text-white/40 hover:text-white"
            />
          </span>
        </div>

        {/* The Studio itself, framed as the window you're about to open —
            thumbnails flip between the real views on the demo instance. */}
        <StudioGallery shots={STUDIO_SHOTS} />
      </Container>
    </section>
  );
}

/** Real Studio views on the seeded Forgeline demo — paths match the SPA's
 * TanStack routes (basepath /studio). */
const STUDIO_SHOTS: StudioShot[] = [
  {
    key: "overview",
    label: "Overview",
    path: "/studio",
    alt: "Hogsend Studio on the demo instance — Forgeline's overview",
    image: studioOverview,
  },
  {
    key: "journeys",
    label: "Journeys",
    path: "/studio/journeys",
    alt: "Studio journeys — every run, wait, and branch observed live",
    image: studioJourneys,
  },
  {
    key: "sends",
    label: "Sends",
    path: "/studio/sends",
    alt: "Studio sends — delivery, opens, and clicks per email",
    image: studioSends,
  },
  {
    key: "events",
    label: "Events",
    path: "/studio/events",
    alt: "Studio events — the ingested event stream",
    image: studioEvents,
  },
  {
    key: "templates",
    label: "Templates",
    path: "/studio/templates",
    alt: "Studio templates — the React Email catalog with previews",
    image: studioTemplates,
  },
  {
    key: "links",
    label: "Links",
    path: "/studio/links",
    alt: "Studio links — tracked links, scans, and clicks",
    image: studioLinks,
  },
  {
    key: "campaigns",
    label: "Campaigns",
    path: "/studio/campaigns",
    alt: "Studio campaigns — broadcasts and their stats",
    image: studioCampaigns,
  },
  {
    key: "buckets",
    label: "Buckets",
    path: "/studio/buckets",
    alt: "Studio buckets — live audience membership",
    image: studioBuckets,
  },
];

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
    <section className="relative tw-section">
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
              <div className="flex h-full flex-col rounded-lg border border-[var(--tw-border)] bg-white/[0.03] p-6">
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
    <section className="relative tw-section">
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
              <ThermalCard
                key={c.title}
                strength={0.08}
                className="rounded-lg bg-white/[0.03]"
              >
                <h3 className="font-medium text-base text-white tracking-[-0.025em]">
                  {c.title}
                </h3>
                <p className="mt-2 text-sm text-white/55 leading-[21px] tracking-[-0.02em]">
                  {c.body}
                </p>
              </ThermalCard>
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
                className="inline-flex items-center gap-2 rounded-[6px] border border-[var(--tw-border)] bg-white/[0.06] px-4 py-2 font-medium text-white text-sm tracking-[-0.025em]"
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
/* --------------------------------------------------------- feature flags -- */

/** The real flag API, three surfaces — shown verbatim beside the live demo. */
const FLAG_SAMPLES = {
  define: `import { defineFlag } from "@hogsend/engine";

// Which team is reading the page? One multivariate flag, one arm each.
export const visitorTeam = defineFlag({
  key: "visitor-team",
  name: "Visitor team",
  type: "multivariate",
  variants: [
    { key: "founder", value: "founder", weight: 1 },
    { key: "growth", value: "growth", weight: 1 },
    { key: "product", value: "product", weight: 1 },
    { key: "sales", value: "sales", weight: 1 },
    { key: "hr", value: "hr", weight: 1 },
  ],
  defaultValue: "founder",
});

export const flags = [visitorTeam];`,
  react: `import { useFlag } from "@hogsend/react";

export function Hero() {
  // One flag decides who's reading. Sticky per visitor, no redeploy.
  const team = useFlag("visitor-team");

  return <TeamHero team={team} />; // swaps the video + the pitch
}`,
  server: `import { Hogsend } from "@hogsend/client";

const hogsend = new Hogsend({ apiKey: process.env.HOGSEND_SECRET_KEY });

// The same flag, resolved for one contact on the server.
const { flags } = await hogsend.flags.evaluate({ userId });

if (flags["visitor-team"] === "founder") {
  // Render the founder page, or branch a journey on the
  // same value, evaluated by the same condition engine.
}`,
} as const;

async function PsFlags() {
  const [defineNode, reactNode, serverNode] = await Promise.all([
    CodeHighlight({ code: FLAG_SAMPLES.define, lang: "ts" }),
    CodeHighlight({ code: FLAG_SAMPLES.react, lang: "tsx" }),
    CodeHighlight({ code: FLAG_SAMPLES.server, lang: "ts" }),
  ]);

  return (
    <section id="flags" className="relative tw-section overflow-hidden">
      <DotPatch className="top-24 right-0 hidden h-36 w-48 lg:block" />
      <Container className="relative pt-16 pb-28">
        <Reveal>
          <Eyebrow>Feature flags</Eyebrow>
          <h2
            className={cn(
              "mt-8 max-w-[860px] font-normal text-[34px] leading-[1.15] tracking-[-0.01em] md:text-[48px] md:leading-[56px]",
              DISPLAY,
            )}
          >
            <span className="text-white">
              Customize the whole journey with feature flags.
            </span>{" "}
            <span className="text-white/40">
              Flip any part of your marketing on or off, anytime. No deploy.
            </span>
          </h2>
          <p className="mt-6 max-w-[680px] text-[17px] text-white/60 leading-relaxed tracking-[-0.01em]">
            Native, DB-backed flags, evaluated against your Hogsend contacts by
            the same targeting engine that runs your journeys. One flag can swap
            a headline, a video, an email, or a whole branch of a journey. Flip
            the arms below and the page reacts, running on the real API on the
            right.
          </p>
        </Reveal>

        <Reveal delay={0.1} className="mt-12 block">
          <FlagPersonaSwitcher
            code={{
              define: defineNode,
              react: reactNode,
              server: serverNode,
            }}
            raw={FLAG_SAMPLES}
          />
        </Reveal>
      </Container>
    </section>
  );
}

async function _PsCode() {
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
    <section className="relative tw-section overflow-hidden">
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

/* ---------------------------------------------------- email answers -- */

/* Real API on both sides of every scenario: each template is a valid React
   Email component using EmailAction (@hogsend/email), each journey side a
   valid ctx.waitForEvent read. The feed in the card is illustrative. */
const EMAIL_ANSWER_SNIPPETS = {
  trial: {
    email: `import { EmailAction } from "@hogsend/email";
import { Section, Text } from "@react-email/components";

export function TrialCheckIn() {
  return (
    <Section>
      <Text>Hey — you're a week in. Where are you?</Text>

      {/* Every answer in an email is a link. Two answers, two EmailActions —
          the click emits trial.check_in through the full ingest pipeline. */}
      <EmailAction
        href="https://app.example.com"
        event="trial.check_in"
        properties={{ answer: "great" }}
      >
        Going great
      </EmailAction>

      <EmailAction
        href="https://cal.com/you/help"
        event="trial.check_in"
        properties={{ answer: "help" }}
      >
        Need a hand
      </EmailAction>
    </Section>
  );
}`,
    journey: `// The journey sends the email, then just waits for the answer.
await sendEmail({ to: user.email, template: "trial-check-in" });

const reply = await ctx.waitForEvent({
  event: "trial.check_in",
  timeout: days(3),
  label: "trial-check-in",
});

// Branch on the answer directly — no webhook wiring, no forms.
if (!reply.timedOut && reply.properties?.answer === "help") {
  await sendEmail({ to: user.email, template: "founder-intro-call" });
}`,
  },
  nps: {
    email: `import { EmailAction } from "@hogsend/email";
import { Section, Text } from "@react-email/components";

const SCORES = Array.from({ length: 11 }, (_, i) => i);

export function NpsSurvey() {
  return (
    <Section>
      <Text>One number — how likely are you to recommend us?</Text>

      {/* Eleven answers, one event. Each number is a link whose click
          emits nps.answered with its score. */}
      {SCORES.map((score) => (
        <EmailAction
          key={score}
          href="https://example.com/thanks"
          event="nps.answered"
          properties={{ score }}
        >
          {String(score)}
        </EmailAction>
      ))}
    </Section>
  );
}`,
    journey: `await sendEmail({ to: user.email, template: "nps-survey" });

const reply = await ctx.waitForEvent({
  event: "nps.answered",
  timeout: days(7),
  label: "nps-survey",
});

// Branch on the score directly — no survey tool, no webhook wiring.
const score = Number(reply.properties?.score);
if (!reply.timedOut && score >= 9) {
  await sendEmail({ to: user.email, template: "nps-review-ask" });
} else if (!reply.timedOut && score <= 6) {
  await sendEmail({ to: user.email, template: "nps-founder-followup" });
}`,
  },
  winback: {
    email: `import { EmailAction } from "@hogsend/email";
import { Section, Text } from "@react-email/components";

export function WinbackReason() {
  return (
    <Section>
      <Text>Your account went quiet. What pulled you away?</Text>

      <EmailAction
        href="https://example.com/pricing"
        event="winback.reason"
        properties={{ reason: "pricing" }}
      >
        Too pricey
      </EmailAction>

      <EmailAction
        href="https://example.com/roadmap"
        event="winback.reason"
        properties={{ reason: "missing_feature" }}
      >
        Missing a feature
      </EmailAction>

      <EmailAction
        href="https://app.example.com"
        event="winback.reason"
        properties={{ reason: "busy" }}
      >
        Just busy
      </EmailAction>
    </Section>
  );
}`,
    journey: `await sendEmail({ to: user.email, template: "winback-reason" });

const reply = await ctx.waitForEvent({
  event: "winback.reason",
  timeout: days(7),
  label: "winback-reason",
});

// A churn reason is a typed event — branch now, segment on it forever.
if (reply.properties?.reason === "missing_feature") {
  await sendEmail({ to: user.email, template: "founder-which-feature" });
} else if (reply.properties?.reason === "busy") {
  await ctx.sleep({ duration: days(30), label: "busy-snooze" });
  await sendEmail({ to: user.email, template: "winback-second-touch" });
}`,
  },
  slot: {
    email: `import { EmailAction } from "@hogsend/email";
import { Section, Text } from "@react-email/components";

export function OnboardingCall() {
  return (
    <Section>
      <Text>Twenty minutes, we set up your first journey. Pick a slot:</Text>

      <EmailAction
        href="https://cal.com/you/onboarding"
        event="onboarding.slot_picked"
        properties={{ slot: "tue-10" }}
      >
        Tuesday 10:00
      </EmailAction>

      <EmailAction
        href="https://cal.com/you/onboarding"
        event="onboarding.slot_picked"
        properties={{ slot: "thu-14" }}
      >
        Thursday 14:00
      </EmailAction>
    </Section>
  );
}`,
    journey: `await sendEmail({ to: user.email, template: "onboarding-call" });

const reply = await ctx.waitForEvent({
  event: "onboarding.slot_picked",
  timeout: days(3),
  label: "onboarding-call",
});

if (!reply.timedOut) {
  // The answer carries the slot — confirm it back in one send.
  await sendEmail({
    to: user.email,
    template: "call-confirmed",
    props: { slot: String(reply.properties?.slot) },
  });
}`,
  },
  vote: {
    email: `import { EmailAction } from "@hogsend/email";
import { Section, Text } from "@react-email/components";

export function RoadmapVote() {
  return (
    <Section>
      <Text>Three candidates for next quarter. Your click is the ballot:</Text>

      <EmailAction
        href="https://example.com/roadmap"
        event="roadmap.vote"
        properties={{ pick: "webhooks" }}
      >
        Webhooks API
      </EmailAction>

      <EmailAction
        href="https://example.com/roadmap"
        event="roadmap.vote"
        properties={{ pick: "sso" }}
      >
        SSO
      </EmailAction>

      <EmailAction
        href="https://example.com/roadmap"
        event="roadmap.vote"
        properties={{ pick: "mobile" }}
      >
        Mobile app
      </EmailAction>
    </Section>
  );
}`,
    journey: `await sendEmail({ to: user.email, template: "roadmap-vote" });

const reply = await ctx.waitForEvent({
  event: "roadmap.vote",
  timeout: days(14),
  label: "roadmap-vote",
});

// The vote is a typed event on the contact — segment on it later,
// and close the loop the day the picked feature ships.
if (!reply.timedOut && reply.properties?.pick === "sso") {
  await sendEmail({ to: user.email, template: "sso-waitlist-confirm" });
}`,
  },
} as const;

async function PsEmailAnswers() {
  const scenarioCode = Object.fromEntries(
    await Promise.all(
      Object.entries(EMAIL_ANSWER_SNIPPETS).map(async ([key, s]) => {
        const [email, journey] = await Promise.all([
          CodeHighlight({ code: s.email, lang: "tsx" }),
          CodeHighlight({ code: s.journey, lang: "ts" }),
        ]);
        return [key, { email, journey }] as const;
      }),
    ),
  ) as Record<
    keyof typeof EMAIL_ANSWER_SNIPPETS,
    { email: ReactNode; journey: ReactNode }
  >;

  return (
    <section id="email-answers" className="relative tw-section overflow-hidden">
      <PlusGrid className="top-20 left-0 hidden h-36 w-48 [mask-image:linear-gradient(to_right,black,transparent)] lg:block" />
      <Container className="relative pt-16 pb-28">
        <Reveal>
          <Eyebrow>In-email answers</Eyebrow>
          <h2
            className={cn(
              "mt-8 max-w-[860px] font-normal text-[34px] leading-[1.15] tracking-[-0.01em] md:text-[48px] md:leading-[56px]",
              DISPLAY,
            )}
          >
            <span className="text-white">The email answers back.</span>{" "}
            <span className="text-white/40">
              A click is a typed event; the journey branches on it. Try it —
              press a button in the email.
            </span>
          </h2>
          <p className="mt-6 max-w-[680px] text-[17px] text-white/60 leading-relaxed tracking-[-0.01em]">
            Every link in every email is rewritten to your own domain at send
            time, so opens and clicks are tracked first-party — no provider
            pixels. An EmailAction goes further: the click emits a named event
            with properties, and a waiting journey reads the answer directly.
          </p>
        </Reveal>

        <Reveal delay={0.1} className="mt-12 block">
          <EmailAnswersCard code={scenarioCode} raw={EMAIL_ANSWER_SNIPPETS} />
        </Reveal>
      </Container>
    </section>
  );
}

/* ---------------------------------------------------- tracked links + QR -- */

/** Real QR codes, generated exactly like the engine's
 * `GET /v1/admin/links/:id/qr` (same `qrcode` library, level M), encoding the
 * durable `/v1/t/c/<uid>` URL — never the slug. The retarget row deliberately
 * reuses the print QR: the whole point is the printed code never changes. */
async function PsLinks() {
  const toSvg = (url: string) =>
    QRCode.toString(url, {
      type: "svg",
      errorCorrectionLevel: "M",
      margin: 0,
    });
  const [printQr, personalQr] = await Promise.all([
    toSvg("https://api.acme.dev/v1/t/c/7f3ad2c8"),
    toSvg("https://api.acme.dev/v1/t/c/b91e64a0"),
  ]);

  return (
    <section id="links" className="relative tw-section overflow-hidden">
      <DotPatch className="top-24 left-0 hidden h-36 w-48 lg:block" />
      <Container className="relative pt-16 pb-28">
        <Reveal className="flex flex-col items-center text-center">
          <Eyebrow>Tracked links + QR</Eyebrow>
          <h2
            className={cn(
              "mt-8 max-w-[860px] font-normal text-[34px] leading-[1.15] tracking-[-0.01em] md:text-[48px] md:leading-[56px]",
              DISPLAY,
            )}
          >
            <span className="text-white">Print runs that report back.</span>{" "}
            <span className="text-white/40">
              Mint a link, get a QR code, put it on anything. The scan is an
              event.
            </span>
          </h2>
          <p className="mt-6 max-w-[680px] text-[17px] text-white/60 leading-relaxed tracking-[-0.01em]">
            Every managed link gets a vanity slug, first-party click tracking,
            and a print-ready SVG or PNG QR code from the API. Scans count
            separately from clicks, a personal link identifies the scanner, and
            because the QR encodes a durable engine URL you can re-point a
            printed code any time.
          </p>
        </Reveal>

        <Reveal delay={0.1} className="mt-12 block">
          <QrLinksCard
            qr={{ print: printQr, personal: personalQr, retarget: printQr }}
          />
        </Reveal>

        <div className="mx-auto mt-10 flex max-w-[720px] flex-wrap items-center justify-between gap-3">
          <p className="max-w-[520px] text-left text-sm text-white/55 tracking-[-0.02em]">
            Direct mail, conference badges, packaging — anything you can print
            becomes a journey trigger.
          </p>
          <Link
            href="/playbook/direct-mail-qr-codes"
            className="font-medium text-sm text-white tracking-[-0.025em] hover:opacity-70"
          >
            Read the direct-mail play →
          </Link>
        </div>
      </Container>
    </section>
  );
}

/* ------------------------------------------------- impact experiments -- */

/* Illustrative readouts — the SHAPE of the report Hogsend generates from a
   team's own journeys and goals, not measured Hogsend results. Numbers are
   internally consistent (lift ≈ treatment ÷ control − 1) and clearly tagged
   `example` in the UI so nothing reads as a sourced claim. */
const IMPACT_STEPS = [
  {
    title: "Version the journey",
    body: "Every edit is a version. Run the new one against the last — no separate tool.",
  },
  {
    title: "Split with a holdout",
    body: "A randomised share gets the change; a control gets nothing to measure against.",
  },
  {
    title: "Read the lift",
    body: "The goal event, measured against the control, with a confidence you can act on.",
  },
];

/* The counterweight column — each card names a problem every lifecycle team
   has, then how the feature answers it (from docs/conversions/impact). */
const IMPACT_FEATURES = [
  {
    title: "Know which edit moved the number",
    body: "You reworked the welcome series three weeks ago — did it work? Every enrollment carries a fingerprint of the journey code that created it, so the readout splits before-vs-after on its own. No tagging, no spreadsheet archaeology.",
    token: "meta.version",
  },
  {
    title: "Split-test without an experiment platform",
    body: "One call inside the journey assigns each user an arm — sticky across retries and redeploys, no assignment service to run. The readout reports every arm against the same control.",
    token: "ctx.variant",
  },
  {
    title: "Proof, not attribution flattery",
    body: 'Opens and clicks can\'t tell you what would have happened anyway. Hold back 10% as a control and the lift is measured against people who got nothing — the only number allowed to say "caused".',
    token: "meta.holdout",
  },
  {
    title: "It won't let you fool yourself",
    body: 'A +40% on twelve users is noise. Under 10 conversions the verdict stays "collecting" — never a percentage; small cohorts ship flagged. You act when the number can carry the decision.',
    token: "smallSample",
  },
];

function PsImpact() {
  return (
    <section id="experiments" className="relative tw-section overflow-hidden">
      <DotPatch className="top-24 left-0 hidden h-36 w-48 [mask-image:linear-gradient(to_right,black,transparent)] lg:block" />
      <Container className="relative pt-16 pb-28">
        <Reveal>
          <Eyebrow>Impact experiments</Eyebrow>
          <h2
            className={cn(
              "mt-8 max-w-[860px] font-normal text-[34px] leading-[1.15] tracking-[-0.01em] md:text-[48px] md:leading-[56px]",
              DISPLAY,
            )}
          >
            <span className="text-white">
              Every journey change is an experiment.
            </span>{" "}
            <span className="text-white/40">So prove it moved the number.</span>
          </h2>
          <p className="mt-6 max-w-[680px] text-[17px] text-white/60 leading-relaxed tracking-[-0.01em]">
            Ship two versions of a journey to a randomised split, hold back a
            control, and Hogsend measures the goal event against it. You get the
            incrementality — the welcome series raised activation, and by how
            much — not a guess.
          </p>
        </Reveal>

        {/* The flag section's column recipe, mirrored: the interactive card
            takes the flag card's 380px column on the LEFT, the supporting
            content takes the wide column on the right. */}
        <div className="mt-14 grid items-start gap-5 lg:grid-cols-[380px_1fr]">
          {/* LEFT — the interactive readout card. */}
          <Reveal>
            <ImpactReadout />
            <p className="mt-5 text-center text-[12px] text-white/35 leading-5 tracking-[-0.01em]">
              Illustrative readout — the report Hogsend generates from your own
              journeys and goals.
            </p>
          </Reveal>

          {/* RIGHT — the fat column: how a readout is made, then the
              feature's real guarantees as cards. */}
          <Reveal delay={0.1}>
            <ol className="flex flex-wrap gap-x-10 gap-y-6">
              {IMPACT_STEPS.map((s, i) => (
                <li key={s.title} className="flex min-w-[220px] flex-1 gap-4">
                  <span
                    aria-hidden="true"
                    className={cn(
                      "mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-[6px] border border-white/15 bg-white/[0.04] font-mono text-[12px] text-white/70",
                    )}
                  >
                    {i + 1}
                  </span>
                  <div>
                    <h3 className="font-medium text-base text-white tracking-[-0.025em]">
                      {s.title}
                    </h3>
                    <p className="mt-1.5 text-sm text-white/55 leading-[21px] tracking-[-0.02em]">
                      {s.body}
                    </p>
                  </div>
                </li>
              ))}
            </ol>

            {/* The guarantees — benchmark-card idiom, API token as the chip. */}
            <div className="mt-8 grid gap-4 sm:grid-cols-2">
              {IMPACT_FEATURES.map((f) => (
                <div
                  key={f.token}
                  className="flex h-full flex-col rounded-lg border border-[var(--tw-border)] bg-white/[0.03] p-5"
                >
                  <h3 className="font-medium text-base text-white tracking-[-0.025em]">
                    {f.title}
                  </h3>
                  <p className="mt-2 flex-1 text-sm text-white/55 leading-[21px] tracking-[-0.02em]">
                    {f.body}
                  </p>
                  <span className="mt-4 inline-flex w-fit items-center rounded-full bg-[#f64838]/[0.08] px-3 py-1 font-mono text-[11px] text-[#f64838]">
                    {f.token}
                  </span>
                </div>
              ))}
            </div>
          </Reveal>

          {/* Footer row — honest note + deep link, spanning both columns
              (the flags section's footer idiom). */}
          <div className="flex flex-wrap items-center justify-between gap-3 lg:col-span-2">
            <p className="max-w-[640px] text-white/55 text-sm tracking-[-0.02em]">
              Attributed, influenced, and incremental stay separate numbers —
              only the holdout-backed one may say "caused". Already live?{" "}
              <code className="font-mono text-[13px] text-white/75">
                hogsend attribution backfill
              </code>{" "}
              credits your whole history.
            </p>
            <Link
              href="/docs/conversions/impact"
              className="font-medium text-white text-sm tracking-[-0.025em] hover:opacity-70"
            >
              Read the impact docs →
            </Link>
          </div>
        </div>
      </Container>
    </section>
  );
}

/* -------------------------------------------------------- timing -- */

/* Verbatim shipping API: ctx.digest (window absorb + flush), ctx.when
   (timezone-resolving fluent scheduler), ctx.sleepUntil (durable). The demo
   card beside it holds the illustrative week. */
const TIMING_SAMPLE = `export const weeklyDigest = defineJourney({
  meta: {
    id: "weekly-digest",
    trigger: { event: "report.shared" },
    entryLimit: "unlimited",
  },
  run: async (user, ctx) => {
    // A week of report.shared events collapses into THIS one run —
    // later events are absorbed and handed back at flush.
    const digest = await ctx.digest({ window: days(7) });

    // Tuesday 09:00 in the READER'S timezone — resolved per user,
    // then slept to durably (survives deploys and restarts).
    await ctx.sleepUntil(ctx.when.next("tuesday").at("09:00"));

    if (!(await ctx.guard.isSubscribed())) return;

    await sendEmail({
      to: user.email,
      template: "weekly-digest",
      props: { sections: Object.groupBy(digest.events, (e) => e.name) },
    });
  },
});`;

async function _PsTiming() {
  const timingNode = await CodeHighlight({ code: TIMING_SAMPLE, lang: "ts" });

  return (
    <section id="timing" className="relative tw-section overflow-hidden">
      <PlusGrid className="top-24 right-0 hidden h-36 w-48 [mask-image:linear-gradient(to_left,black,transparent)] lg:block" />
      <Container className="relative pt-16 pb-28">
        <Reveal>
          <Eyebrow>Timing primitives</Eyebrow>
          <h2
            className={cn(
              "mt-8 max-w-[860px] font-normal text-[34px] leading-[1.15] tracking-[-0.01em] md:text-[48px] md:leading-[56px]",
              DISPLAY,
            )}
          >
            <span className="text-white">
              A week of noise. One email, Tuesday 9am.
            </span>{" "}
            <span className="text-white/40">Their 9am, not yours.</span>
          </h2>
          <p className="mt-6 max-w-[680px] text-[17px] text-white/60 leading-relaxed tracking-[-0.01em]">
            ctx.digest absorbs a window of trigger events into one run and hands
            them back at flush. ctx.when turns &ldquo;Tuesday 09:00&rdquo; into
            an absolute instant in each reader&rsquo;s own timezone, and the
            sleep to it is durable — deploys and restarts don&rsquo;t lose the
            send.
          </p>
        </Reveal>

        <Reveal delay={0.1} className="mt-12 block">
          <div className="grid items-start gap-5 lg:grid-cols-[1fr_380px]">
            <div className="overflow-hidden rounded-lg border border-[var(--tw-border)] bg-[var(--tw-ink-high)] shadow-xl">
              <div className="flex items-center justify-between border-white/[0.08] border-b px-4">
                <span className="border-[#f64838] border-b-2 py-2.5 font-mono text-[11px] text-white/75 tracking-wide">
                  src/journeys/weekly-digest.ts
                </span>
                <CopyButton value={TIMING_SAMPLE} />
              </div>
              <div className="ps-code max-h-[440px] overflow-auto px-4 py-4 text-[12.5px]">
                {timingNode}
              </div>
            </div>
            <TimingCard />
          </div>
        </Reveal>
      </Container>
    </section>
  );
}

/* -------------------------------------------------------- discord -- */

function PsDiscord() {
  return (
    <section id="discord" className="relative tw-section overflow-hidden">
      <DotPatch className="top-24 right-0 hidden h-36 w-48 lg:block" />
      <Container className="relative pt-16 pb-28">
        <Reveal>
          <Eyebrow>Community channel</Eyebrow>
          <h2
            className={cn(
              "mt-8 max-w-[860px] font-normal text-[34px] leading-[1.15] tracking-[-0.01em] md:text-[48px] md:leading-[56px]",
              DISPLAY,
            )}
          >
            <span className="text-white">
              Your Discord is a lifecycle channel.
            </span>{" "}
            <span className="text-white/40">
              One /link folds a member onto their contact — then journeys can DM
              them.
            </span>
          </h2>
          <p className="mt-6 max-w-[680px] text-[17px] text-white/60 leading-relaxed tracking-[-0.01em]">
            The bot verifies through their inbox — a one-click emailed confirm,
            never the Discord-reported address. From then on presence, messages,
            and reactions keep a last-seen on the contact, and a journey can
            send a DM the same way it sends an email, gated on the
            member&rsquo;s channel preference.
          </p>
        </Reveal>

        <Reveal delay={0.1} className="mt-12 block">
          <DiscordLinkCard />
        </Reveal>

        <div className="mt-10 flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-[640px] text-sm text-white/55 tracking-[-0.02em]">
            Built for community-led companies — the channel your users actually
            read, wired into the same journeys as email and SMS.
          </p>
          <Link
            href="/docs/integrations/discord"
            className="font-medium text-sm text-white tracking-[-0.025em] hover:opacity-70"
          >
            Read the Discord docs →
          </Link>
        </div>
      </Container>
    </section>
  );
}

/* -------------------------------------------------------- contact groups -- */

/* Verbatim shipping API: @hogsend/js group()/capture (association-only) and
   @hogsend/client groups.identify/addMember (secret-key writes). */
const GROUPS_BROWSER_SAMPLE = `import { createHogsend } from "@hogsend/js";

const hogsend = createHogsend({ apiUrl, publishableKey: "pk_…" });

// Bill's session — tie him to the account
hogsend.group("company", "acme.com");
hogsend.group("team", "growth");

// every capture now carries { company, team }
hogsend.capture("feature_used");`;

const GROUPS_SERVER_SAMPLE = `// server — the secret key writes properties
await hogsend.groups.identify({
  groupType: "company",
  groupKey: "acme.com",
  displayName: "Acme Inc",
  properties: { plan: "scale", seats: 40 },
});

await hogsend.groups.addMember({
  groupType: "company",
  groupKey: "acme.com",
  contactId: bill.id,
  role: "admin",
});`;

const GROUPS_FEATURES: { title: string; body: string; token: string }[] = [
  {
    title: "Any shared entity",
    body: "A group is a (type, key) pair — company acme.com, team growth, a household, an account. The first event creates it; no schema to migrate.",
    token: '("company", "acme.com")',
  },
  {
    title: "Standalone, DB-first",
    body: "Groups, memberships, and the per-event association live in Hogsend's own tables. Works with zero analytics provider configured.",
    token: "user_events.groups",
  },
  {
    title: "PostHog for free",
    body: "When PostHog is connected, associations forward as $groups on every mirrored capture and property writes call groupIdentify.",
    token: "$groups",
  },
  {
    title: "Browser associates, server writes",
    body: "A publishable key can only attach a group to events. Group properties and memberships are secret-key writes, enforced at the route.",
    token: "groups.identify()",
  },
];

/** A compact account-rollup visual: three people resolve into one Acme
 *  account with live properties — what "treat them as one account" looks like. */
function GroupRollup() {
  const members = [
    { name: "Bill", email: "bill@acme.com", tint: "#f64838" },
    { name: "Derek", email: "derek@acme.com", tint: "#c98bff" },
    { name: "Bob", email: "bob@acme.com", tint: "#ff9a6c" },
  ];
  return (
    <div className="grid items-center gap-6 rounded-xl border border-[var(--tw-border)] bg-white/[0.02] p-6 md:grid-cols-[1fr_auto_1fr] md:p-8">
      {/* the three contacts */}
      <div className="flex flex-col gap-2.5">
        {members.map((m) => (
          <div
            key={m.email}
            className="flex items-center gap-3 rounded-lg border border-[var(--tw-border)] bg-white/[0.03] px-3.5 py-2.5"
          >
            <span
              aria-hidden="true"
              className="flex size-7 shrink-0 items-center justify-center rounded-full font-medium text-[11px] text-white"
              style={{ backgroundColor: m.tint }}
            >
              {m.name.slice(0, 1)}
            </span>
            <span className="font-medium text-[13px] text-white/85">
              {m.name}
            </span>
            <span className="truncate font-mono text-[11px] text-white/35">
              {m.email}
            </span>
          </div>
        ))}
      </div>

      {/* the association arrow */}
      <div className="flex items-center justify-center">
        <span
          aria-hidden="true"
          className="hidden font-mono text-[#f64838] text-lg md:inline"
        >
          →
        </span>
        <span
          aria-hidden="true"
          className="font-mono text-[#f64838] text-lg md:hidden"
        >
          ↓
        </span>
      </div>

      {/* the account they roll up into */}
      <div className="overflow-hidden rounded-lg border border-[#f64838]/25 bg-[#f64838]/[0.06]">
        <div className="flex items-center gap-3 border-white/[0.06] border-b px-4 py-3">
          <span
            aria-hidden="true"
            className="flex size-8 shrink-0 items-center justify-center rounded-md bg-white/10 font-semibold text-[13px] text-white"
          >
            A
          </span>
          <div className="min-w-0">
            <p className="font-medium text-[14px] text-white">Acme</p>
            <p className="font-mono text-[10.5px] text-white/40">
              company · acme.com
            </p>
          </div>
        </div>
        <dl className="grid grid-cols-3 divide-x divide-white/[0.06]">
          {[
            ["plan", "pro"],
            ["seats", "42"],
            ["members", "3"],
          ].map(([k, v]) => (
            <div key={k} className="px-3 py-2.5 text-center">
              <dt className="font-mono text-[9.5px] text-white/35 uppercase tracking-[0.06em]">
                {k}
              </dt>
              <dd className="mt-0.5 font-medium text-[14px] text-white">{v}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

async function PsGroups() {
  const browserNode = await CodeHighlight({
    code: GROUPS_BROWSER_SAMPLE,
    lang: "ts",
  });
  const serverNode = await CodeHighlight({
    code: GROUPS_SERVER_SAMPLE,
    lang: "ts",
  });

  return (
    <section id="groups" className="relative tw-section overflow-hidden">
      <DotPatch className="top-24 left-0 hidden h-36 w-48 [mask-image:linear-gradient(to_right,black,transparent)] lg:block" />
      <Container className="relative pt-16 pb-28">
        <Reveal>
          <Eyebrow>Contact groups</Eyebrow>
          <h2
            className={cn(
              "mt-8 max-w-[860px] font-normal text-[34px] leading-[1.15] tracking-[-0.01em] md:text-[48px] md:leading-[56px]",
              DISPLAY,
            )}
          >
            <span className="text-white">
              Bill, Derek, and Bob all work at Acme.
            </span>{" "}
            <span className="text-white/40">
              Hogsend can treat them as one account.
            </span>
          </h2>
          <p className="mt-6 max-w-[680px] text-[17px] text-white/60 leading-relaxed tracking-[-0.01em]">
            Contact groups roll individual activity up to the company, team, or
            workspace it belongs to. One call associates a contact with a group;
            every event they fire carries the association, membership accrues
            automatically, and the account reads back as one entity in Studio.
          </p>
        </Reveal>

        <Reveal delay={0.05} className="mt-12 block">
          <GroupRollup />
        </Reveal>

        <Reveal delay={0.1} className="mt-5 block">
          <div className="grid items-start gap-5 lg:grid-cols-[1fr_380px]">
            <div className="flex flex-col gap-5">
              <div className="overflow-hidden rounded-lg border border-[var(--tw-border)] bg-[var(--tw-ink-high)] shadow-xl">
                <div className="flex items-center justify-between border-white/[0.08] border-b px-4">
                  <span className="border-[#f64838] border-b-2 py-2.5 font-mono text-[11px] text-white/75 tracking-wide">
                    browser — @hogsend/js
                  </span>
                  <CopyButton value={GROUPS_BROWSER_SAMPLE} />
                </div>
                <div className="ps-code overflow-auto px-4 py-4 text-[12.5px]">
                  {browserNode}
                </div>
              </div>
              <div className="overflow-hidden rounded-lg border border-[var(--tw-border)] bg-[var(--tw-ink-high)] shadow-xl">
                <div className="flex items-center justify-between border-white/[0.08] border-b px-4">
                  <span className="border-[#f64838] border-b-2 py-2.5 font-mono text-[11px] text-white/75 tracking-wide">
                    server — @hogsend/client
                  </span>
                  <CopyButton value={GROUPS_SERVER_SAMPLE} />
                </div>
                <div className="ps-code overflow-auto px-4 py-4 text-[12.5px]">
                  {serverNode}
                </div>
              </div>
            </div>

            <div className="grid gap-4">
              {GROUPS_FEATURES.map((f) => (
                <div
                  key={f.token}
                  className="flex flex-col rounded-lg border border-[var(--tw-border)] bg-white/[0.03] p-5"
                >
                  <h3 className="font-medium text-base text-white tracking-[-0.025em]">
                    {f.title}
                  </h3>
                  <p className="mt-2 text-sm text-white/55 leading-[21px] tracking-[-0.02em]">
                    {f.body}
                  </p>
                  <span className="mt-4 inline-flex w-fit items-center rounded-full bg-[#f64838]/[0.08] px-3 py-1 font-mono text-[11px] text-[#f64838]">
                    {f.token}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </Reveal>

        <div className="mt-10 flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-[640px] text-sm text-white/55 tracking-[-0.02em]">
            Journeys are person-scoped today — group-level journeys are a later
            phase, not a fine-print surprise.
          </p>
          <Link
            href="/articles/hogsend-0-50-the-big-one"
            className="font-medium text-sm text-white tracking-[-0.025em] hover:opacity-70"
          >
            Read the 0.50 write-up →
          </Link>
        </div>
      </Container>
    </section>
  );
}

/* --------------------------------------------------------- event plugins -- */

/* One entry per tool the plugin system deals with. Monochrome brand marks in
   public/images/logos/, painted via CSS mask so they all read as one set.
   `ratio` = the SVG's viewBox aspect ratio (width / height); wordmark-shaped
   marks (Attio, Crisp) carry their own name, so `wordmark` skips the label.
   `soon` = the integration is real but not on main yet — rendered dimmed. */
const SOURCE_LOGOS: {
  name: string;
  file: string;
  ratio: number;
  wordmark?: boolean;
  soon?: boolean;
}[] = [
  { name: "Stripe", file: "stripe.svg", ratio: 1 },
  { name: "Clerk", file: "clerk.svg", ratio: 1 },
  { name: "Supabase", file: "supabase.svg", ratio: 1 },
  { name: "Segment", file: "segment.svg", ratio: 1 },
  { name: "Intercom & Fin", file: "intercom.svg", ratio: 1 },
  {
    name: "Vapi",
    file: "vapi.svg",
    ratio: 33.8 / 9.8,
    wordmark: true,
    soon: true,
  },
  { name: "Twilio", file: "twilio.svg", ratio: 1 },
  { name: "Discord", file: "discord.svg", ratio: 1 },
  { name: "Telegram", file: "telegram.svg", ratio: 1 },
  { name: "PostHog", file: "posthog.svg", ratio: 1 },
  { name: "Resend", file: "resend.svg", ratio: 1 },
  {
    name: "Crisp",
    file: "crisp.svg",
    ratio: 1651 / 647,
    wordmark: true,
    soon: true,
  },
  { name: "Postmark", file: "postmark.svg", ratio: 1 },
  { name: "HubSpot", file: "hubspot.svg", ratio: 1 },
  { name: "Attio", file: "attio.svg", ratio: 103 / 26, wordmark: true },
  { name: "HighLevel", file: "gohighlevel.svg", ratio: 15 / 23 },
  { name: "Meta CAPI", file: "meta.svg", ratio: 1 },
  { name: "Slack", file: "slack.svg", ratio: 1, soon: true },
];

/* Three marquee lanes — roughly equal, "soon" entries spread across lanes so
   no single lane reads as the graveyard. */
const SOURCE_LANES = [
  SOURCE_LOGOS.slice(0, 6),
  SOURCE_LOGOS.slice(6, 12),
  SOURCE_LOGOS.slice(12),
];

/** A brand SVG painted as a flat silhouette via CSS mask (inherits color). */
function BrandMark({ file, ratio }: { file: string; ratio: number }) {
  const url = `url(/images/logos/${file})`;
  return (
    <span
      aria-hidden="true"
      className="inline-block h-7 bg-current"
      style={{
        WebkitMaskImage: url,
        maskImage: url,
        WebkitMaskRepeat: "no-repeat",
        maskRepeat: "no-repeat",
        WebkitMaskSize: "contain",
        maskSize: "contain",
        WebkitMaskPosition: "center",
        maskPosition: "center",
        aspectRatio: String(ratio),
      }}
    />
  );
}

function PsSources() {
  return (
    <section id="sources" className="relative tw-section overflow-hidden">
      <PlusGrid className="top-24 left-0 hidden h-36 w-48 [mask-image:linear-gradient(to_right,black,transparent)] lg:block" />
      <Container className="relative pt-16 pb-28">
        <Reveal>
          <Eyebrow>Event plugins</Eyebrow>
          <h2
            className={cn(
              "mt-8 max-w-[860px] font-normal text-[34px] leading-[1.15] tracking-[-0.01em] md:text-[48px] md:leading-[56px]",
              DISPLAY,
            )}
          >
            <span className="text-white">
              People do more than click emails.
            </span>{" "}
            <span className="text-white/40">
              Payments, sign-ups, support threads, SMS replies — all journey
              triggers.
            </span>
          </h2>
          <p className="mt-6 max-w-[680px] text-[17px] text-white/60 leading-relaxed tracking-[-0.01em]">
            There&rsquo;s one plugin system behind all of these — webhook
            presets in the engine, @hogsend/plugin-* packages beside it, built
            in the open in the same repo. Signals land as first-class events
            that trigger, branch, or exit a journey; the CRM and ads legs carry
            conversions back out.
          </p>
        </Reveal>

        <Reveal delay={0.1} className="mt-14 block">
          <div className="flex flex-col gap-8">
            {SOURCE_LANES.map((lane, i) => (
              <LogoMarquee
                // biome-ignore lint/suspicious/noArrayIndexKey: static lanes, order is stable
                key={i}
                // Each half of the marquee track must be wider than the
                // viewport or the -50% wrap shows as a jump — repeat the
                // six-logo lane so a half is ~12 items wide.
                items={[...lane, ...lane].map((l, j) => (
                  <span
                    // biome-ignore lint/suspicious/noArrayIndexKey: static duplicated lane, order is stable
                    key={`${l.name}-${j}`}
                    className={cn(
                      "flex items-center gap-3",
                      l.soon ? "text-white/30" : "text-white/75",
                    )}
                  >
                    <BrandMark file={l.file} ratio={l.ratio} />
                    {l.wordmark ? (
                      <span className="sr-only">{l.name}</span>
                    ) : (
                      <span className="whitespace-nowrap text-[19px] tracking-[-0.02em]">
                        {l.name}
                      </span>
                    )}
                    {l.soon ? (
                      <span className="font-mono text-[10px] text-white/30 uppercase tracking-wide">
                        soon
                      </span>
                    ) : null}
                  </span>
                ))}
                durationSec={[64, 80, 72][i]}
              />
            ))}
          </div>
        </Reveal>

        <div className="mt-10 flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-[640px] text-sm text-white/55 tracking-[-0.02em]">
            Every preset is defineWebhookSource() under the hood — a source we
            don&rsquo;t ship is a transform function away.
          </p>
          <Link
            href="/integrations"
            className="font-medium text-sm text-white tracking-[-0.025em] hover:opacity-70"
          >
            See all integrations →
          </Link>
        </div>
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
    <section id="posthog-workflows" className="relative tw-section">
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
  { text: "→ cd my-app && pnpm hogsend dev", dim: false },
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
    <div className="rounded-2xl border border-[var(--tw-border)] bg-white/[0.04] p-6">
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
    body: "pnpm dlx create-hogsend@latest emits a thin app that pins @hogsend/engine and holds your content. Pass --domain to wire your sending domain from the start.",
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
    <section className="relative tw-section overflow-hidden">
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

/* ---------------------------------------------------------- feature index -- */

/** Every entry hot-links to a section further down this page. */
const FEATURE_INDEX: Array<{ label: string; href: string }> = [
  { label: "Video events", href: "#video" },
  { label: "Feature flags", href: "#flags" },
  { label: "Contact groups", href: "#groups" },
  { label: "In-email answers", href: "#email-answers" },
  { label: "Links & QR", href: "#links" },
  { label: "Discord", href: "#discord" },
  { label: "Event plugins", href: "#sources" },
  { label: "Impact experiments", href: "#experiments" },
  { label: "Durable execution", href: "#hatchet" },
];

function PsFeatureIndex({ engineVersion }: { engineVersion?: string }) {
  return (
    <section className="relative tw-section overflow-hidden">
      <Container className="pt-20 pb-16 md:pt-24">
        <Reveal>
          <Eyebrow>Feature index</Eyebrow>
          <h2
            className={cn(
              "mt-8 max-w-[860px] font-normal text-[34px] leading-[1.15] tracking-[-0.01em] md:text-[48px] md:leading-[56px]",
              DISPLAY,
            )}
          >
            <span className="text-white">
              Here&apos;s everything that&apos;s in Hogsend today.
            </span>{" "}
            <span className="text-white/40">
              {engineVersion ? `All of it is in v${engineVersion}. ` : null}
              Jump straight to a feature.
            </span>
          </h2>
          <span
            aria-hidden="true"
            className="mt-8 inline-block animate-bounce font-mono text-[#f64838] text-2xl"
          >
            ↓
          </span>
          <div className="mt-6 flex max-w-[900px] flex-wrap gap-2">
            {FEATURE_INDEX.map((f) => (
              <a
                key={f.href}
                href={f.href}
                className="rounded-full border border-[var(--tw-border)] bg-white/[0.05] px-3.5 py-2 font-mono text-[12px] text-white/60 transition-colors hover:border-[#f64838]/40 hover:text-white"
              >
                {f.label}
              </a>
            ))}
          </div>
        </Reveal>
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

const BLOCK_TIMING = `run: async (user, ctx) => {
  // A noisy week of events collapses into THIS one run —
  // later events are absorbed and handed back at flush.
  const digest = await ctx.digest({ window: days(7) });
  if (!digest.count) return;

  // Tuesday 09:00 in the READER'S timezone — resolved per
  // user, then slept to durably (survives deploys).
  await ctx.sleepUntil(ctx.when.next("tuesday").at("09:00"));

  await sendEmail({
    to: user.email,
    template: "weekly-digest",
    props: { events: digest.events },
  });
}`;

const BLOCK_VARIANT = `run: async (user, ctx) => {
  // Deterministic per user — recorded on first pass,
  // replayed verbatim across redeploys. No RNG, no drift.
  const arm = await ctx.variant("welcome-subject", [
    "setup",
    "outcome",
  ]);

  await sendEmail({
    to: user.email,
    template: arm === "setup" ? "welcome-setup" : "welcome-outcome",
  });
}`;

const BLOCK_FLAGS = `// Flags live in your repo — typed, reviewed, deployed.
export const newCheckout = defineFlag({
  key: "new-checkout-flow",
  name: "New checkout flow",
  type: "boolean",
});

// In React — the same shape as PostHog's hook:
const enabled = useFlag("new-checkout-flow");`;

const BLOCK_SMS = `run: async (user) => {
  const phone = String(user.properties.phone ?? "");
  // SMS is additive — no number, no send.
  if (!isE164(phone)) return;

  // Marketing SMS fails closed without explicit consent;
  // the STOP list is checked on every send.
  await sendSms({
    to: phone,
    userId: user.id,
    template: "cart-reminder",
  });
}`;

const BLOCK_CONNECTORS = `// DM them where they actually are — gated on the
// member's channel preference. A closed DM is a soft
// failure (delivered: false), never a crash.
await sendConnectorAction({
  connectorId: "discord",
  action: "dmMember",
  args: {
    member: user.email,
    content: "Your seat is ready — see you in #welcome.",
  },
});`;

const BLOCK_GROUPS = `// Server — write the account and its properties.
await hs.groups.identify({
  groupType: "company",
  groupKey: "acme.com",
  properties: { plan: "pro", seats: 42 },
});

// Browser — associate this visitor's events with it.
hogsend.group("company", "acme.com");`;

const BLOCK_SOURCES = `export const billing = defineWebhookSource({
  meta: { id: "billing", name: "Billing" },
  auth: {
    type: "match",
    header: "x-webhook-secret",
    envKey: "BILLING_WEBHOOK_SECRET",
  },
  schema: z.object({
    type: z.string(),
    customer: z.object({ id: z.string(), email: z.string() }),
  }),
  async transform(payload) {
    return {
      userId: payload.customer.id,
      email: payload.customer.email,
      event: payload.type,
    };
  },
});`;

const BLOCK_LINKS = `# Mint a tracked link — vanity slug, QR from the same API
$ curl -X POST $API/v1/admin/links \\
    -d '{"url":"https://example.com/launch","slug":"spring-mailer"}'
→ vanity /l/spring-mailer · QR via /v1/admin/links/:id/qr

# The printed QR encodes the durable id, never the URL —
# re-point 5,000 postcards with one call
$ curl -X PATCH $API/v1/admin/links/$ID \\
    -d '{"originalUrl":"https://example.com/spring-offer-v2"}'`;

const BLOCK_CAMPAIGNS = `const { campaignId, status } = await hs.campaigns.send({
  name: "March launch",
  list: "product-updates",        // or a live bucket
  template: "launch-announcement", // typed against your registry
  props: { feature: "Flags" },
  sendAt: "2026-08-01T09:00:00Z",  // omit to send now
});`;

const BLOCK_MCP = `{
  "mcpServers": {
    "hogsend": {
      "command": "npx",
      "args": ["-y", "@hogsend/mcp"],
      "env": {
        "HOGSEND_API_URL": "https://api.your-instance.com",
        "HOGSEND_ADMIN_KEY": "hsk_…"
      }
    }
  }
}`;

/** The homepage BuildingBlocks showcase, re-set light: a vertical tab rail
 * over real-code panels (async Shiki nodes composed into the client tabs). */
async function _PsBuildingBlocks() {
  const [
    journeyMedia,
    waitMedia,
    answersMedia,
    trackingMedia,
    providerMedia,
    bucketMedia,
    destinationsMedia,
    posthogMedia,
    timingMedia,
    variantMedia,
    flagsMedia,
    smsMedia,
    connectorsMedia,
    groupsMedia,
    sourcesMedia,
    linksMedia,
    campaignsMedia,
    mcpMedia,
  ] = await Promise.all([
    CodeHighlight({ code: BLOCK_JOURNEY, lang: "ts" }),
    CodeHighlight({ code: BLOCK_WAIT, lang: "ts" }),
    CodeHighlight({ code: BLOCK_ANSWERS, lang: "tsx" }),
    CodeHighlight({ code: BLOCK_TRACKING, lang: "ts" }),
    CodeHighlight({ code: BLOCK_PROVIDER, lang: "bash" }),
    CodeHighlight({ code: BLOCK_BUCKET, lang: "ts" }),
    CodeHighlight({ code: BLOCK_DESTINATIONS, lang: "ts" }),
    CodeHighlight({ code: BLOCK_POSTHOG, lang: "bash" }),
    CodeHighlight({ code: BLOCK_TIMING, lang: "ts" }),
    CodeHighlight({ code: BLOCK_VARIANT, lang: "ts" }),
    CodeHighlight({ code: BLOCK_FLAGS, lang: "tsx" }),
    CodeHighlight({ code: BLOCK_SMS, lang: "ts" }),
    CodeHighlight({ code: BLOCK_CONNECTORS, lang: "ts" }),
    CodeHighlight({ code: BLOCK_GROUPS, lang: "ts" }),
    CodeHighlight({ code: BLOCK_SOURCES, lang: "ts" }),
    CodeHighlight({ code: BLOCK_LINKS, lang: "bash" }),
    CodeHighlight({ code: BLOCK_CAMPAIGNS, lang: "ts" }),
    CodeHighlight({ code: BLOCK_MCP, lang: "json" }),
  ]);

  const tabs = [
    {
      id: "journeys",
      label: "Journeys",
      group: "Author",
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
      group: "Author",
      title: "Wait for what they do next",
      description:
        "Pause the journey until the user acts or a timeout wins. The wait is durable, so it survives deploys, and the branch afterwards is an if statement.",
      tags: ["Durable wait", "Event or timeout", "Survives deploys"],
      filename: "src/journeys/welcome.ts",
      media: waitMedia,
    },
    {
      id: "timing",
      label: "Digest & timing",
      group: "Author",
      title: "Collapse the noise, land the moment",
      description:
        "ctx.digest absorbs a week of events into one run; ctx.when schedules the send for Tuesday 09:00 in each reader's own timezone — resolved per user, slept to durably.",
      tags: ["One send, not five", "Their timezone", "Durable sleep"],
      filename: "src/journeys/weekly-digest.ts",
      media: timingMedia,
    },
    {
      id: "experiments",
      label: "Experiments",
      group: "Author",
      title: "A/B arms inside the journey",
      description:
        "ctx.variant deals each user a deterministic arm — recorded on first pass and replayed verbatim across redeploys, so a crash never flips someone's experience mid-journey.",
      tags: ["Deterministic split", "Recorded per user", "Replay-safe"],
      filename: "src/journeys/welcome.ts",
      media: variantMedia,
    },
    {
      id: "flags",
      label: "Feature flags",
      group: "Author",
      title: "Flags defined next to the journeys",
      description:
        "defineFlag puts the flag in your repo; useFlag reads it in React with the same shape as PostHog's hook. One flag can gate an email, a page, or a whole journey branch.",
      tags: ["Code-first", "Typed keys", "useFlag in React"],
      filename: "src/flags/index.ts",
      media: flagsMedia,
    },
    {
      id: "answers",
      label: "In-email answers",
      group: "Channels",
      title: "Ask a question inside the email",
      description:
        "A yes/no, an NPS score, a one-tap choice — each answer is a link whose click fires a real event with its payload. The journey branches on the answer; PostHog receives it under your event name.",
      tags: ["NPS & yes/no", "Answer = event", "Scanner-safe"],
      filename: "src/emails/nps.tsx",
      media: answersMedia,
    },
    {
      id: "provider",
      label: "Your provider",
      group: "Channels",
      title: "Send through your own account",
      description:
        "Email goes out through your own Resend or Postmark — your domain, your reputation, your costs. Swapping the provider is one env var; the journey code never changes.",
      tags: ["Resend · Postmark", "Your domain", "Config, not code"],
      filename: ".env",
      media: providerMedia,
    },
    {
      id: "sms",
      label: "SMS",
      group: "Channels",
      title: "Texts with the same guardrails",
      description:
        "sendSms runs the same pipeline as email — consent-gated (marketing fails closed without an explicit grant), STOP list checked on every send, links shortened and tracked.",
      tags: ["Consent-gated", "STOP handled", "Tracked short links"],
      filename: "src/journeys/cart-reminder.ts",
      media: smsMedia,
    },
    {
      id: "connectors",
      label: "Discord & Telegram",
      group: "Channels",
      title: "Reach them where they hang out",
      description:
        "Journeys can DM a linked Discord or Telegram member through one call. Sends respect the member's channel preference, and a closed DM is a soft failure, not a crash.",
      tags: ["dmMember", "Preference-gated", "Soft failures"],
      filename: "src/journeys/community.ts",
      media: connectorsMedia,
    },
    {
      id: "broadcasts",
      label: "Broadcasts",
      group: "Channels",
      title: "One-off sends to a list or bucket",
      description:
        "campaigns.send takes a list or a live bucket plus a template from your registry — typed props included — and runs the send in the worker. Schedule it or send now.",
      tags: ["List or bucket", "Typed template", "Schedule or now"],
      filename: "scripts/launch.ts",
      media: campaignsMedia,
    },
    {
      id: "buckets",
      label: "Buckets",
      group: "Audience",
      title: "Live groups of people",
      description:
        "Define who belongs with declarative criteria. Membership updates as events arrive, and joining a bucket can kick off a journey on its own.",
      tags: ["Live membership", "Time-based", "Kick off journeys"],
      filename: "src/buckets/went-dormant.ts",
      media: bucketMedia,
    },
    {
      id: "groups",
      label: "Groups",
      group: "Audience",
      title: "Accounts, teams, companies",
      description:
        "Track the company behind the person. The server writes group properties; the browser associates a visitor's events with their account. When PostHog is connected, it all forwards as group analytics.",
      tags: ["Account-level", "B2B events", "PostHog $groups"],
      filename: "src/lib/accounts.ts",
      media: groupsMedia,
    },
    {
      id: "sources",
      label: "Webhook sources",
      group: "Audience",
      title: "Any webhook becomes a trigger",
      description:
        "defineWebhookSource verifies, validates with Zod, and transforms any inbound webhook into an event — Stripe, Segment, Intercom, or your own billing system. The result can enroll journeys directly.",
      tags: ["Verified inbound", "Zod-validated", "Enrolls journeys"],
      filename: "src/webhook-sources/billing.ts",
      media: sourcesMedia,
    },
    {
      id: "tracking",
      label: "Tracking",
      group: "Observe & fan out",
      title: "Opens and clicks, first-party",
      description:
        "Every send is tracked first-party for opens and link clicks; engagement flows back as events you can branch on mid-journey or fan out to your destinations.",
      tags: ["Open tracking", "Click tracking", "Any channel"],
      filename: "src/journeys/welcome.ts",
      media: trackingMedia,
    },
    {
      id: "links",
      label: "Links & QR",
      group: "Observe & fan out",
      title: "Tracked links that survive the print run",
      description:
        "Mint a link, get a vanity slug and a QR from the same API. The QR encodes the durable id — never the destination — so a printed code can be re-pointed after the mailers ship.",
      tags: ["Vanity /l/slug", "SVG & PNG QR", "Re-point later"],
      filename: "terminal",
      media: linksMedia,
    },
    {
      id: "destinations",
      label: "Destinations",
      group: "Observe & fan out",
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
      group: "Observe & fan out",
      title: "Connect PostHog in one command",
      description:
        "The scaffold asks if you're using PostHog and writes the keys. Once deployed, hogsend connect posthog opens one browser consent and wires the rest.",
      tags: ["One command, one click", "Person reads wired", "Round-trip safe"],
      filename: "terminal",
      media: posthogMedia,
    },
    {
      id: "mcp",
      label: "Agents & MCP",
      group: "Observe & fan out",
      title: "Your agent operates the engine",
      description:
        "@hogsend/mcp runs over stdio or hosted at /v1/mcp. An admin-scoped agent can draft journey blueprints, pull reports, and send operator-gated test emails.",
      tags: ["stdio & hosted", "Blueprints", "Reports"],
      filename: "claude_desktop_config.json",
      media: mcpMedia,
    },
  ];

  return (
    <section id="building-blocks" className="relative tw-section">
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

/* -------------------------------------------------------- core platform -- */

function _PsCorePlatform() {
  return (
    <section className="relative">
      <Container className="py-20">
        <div className="relative overflow-hidden rounded-2xl border border-[var(--tw-border)] bg-[#0a0606] p-8 text-white md:p-12">
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

/**
 * The one demonstrable fact of durable execution, drawn as structure: a
 * journey run as a horizontal track whose ctx.sleep segment crosses a
 * deploy cut — and keeps going. A slow pulse travels the track.
 */
function HatchetRunTimeline() {
  const CY = 96; // track y
  const STEPS = [
    { x: 30, label: "user.signed_up", sub: "day 0", filled: false },
    { x: 250, label: "sendEmail(welcome)", sub: "day 0", filled: false },
    { x: 410, label: "ctx.sleep(days(7))", sub: "sleep starts", sleep: true },
    { x: 830, label: "sendEmail(check_in)", sub: "day 7", filled: true },
  ];
  const DEPLOY_X = 620;
  return (
    <div
      className="relative mt-10 overflow-hidden rounded-lg border border-[var(--tw-border)] bg-[#0a0606] md:mt-14"
      aria-hidden="true"
    >
      <style>{`
        @media (prefers-reduced-motion: reduce) {
          .hs-run-pulse { display: none; }
        }
      `}</style>
      <div className="flex items-center justify-between gap-3 border-white/10 border-b px-4 py-3 md:px-5">
        <span className="min-w-0 truncate font-mono text-[10px] text-white/40 uppercase tracking-[0.08em] md:text-[11px]">
          run · src/journeys/onboarding.ts
        </span>
        <span className="flex shrink-0 items-center gap-1.5 font-mono text-[#23c489] text-[10px] md:text-[11px]">
          <span className="relative flex size-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#23c489] opacity-60" />
            <span className="relative inline-flex size-2 rounded-full bg-[#23c489]" />
          </span>
          running
          <span className="hidden sm:inline"> · resumed after deploy</span>
        </span>
      </div>

      {/* mobile: vertical run — real text, nothing scales down */}
      <div className="px-4 py-5 md:hidden">
        {STEPS.map((s, i) => {
          const sleepLeg = i === 2; // segment after ctx.sleep crosses the deploy
          return (
            <div key={s.label} className="flex gap-3.5">
              <div className="flex w-3.5 shrink-0 flex-col items-center">
                <span
                  className="mt-[3px] size-3 shrink-0 rounded-full border-[1.5px]"
                  style={{
                    borderColor: s.sleep ? "#f64838" : "rgba(255,255,255,0.5)",
                    background: s.filled ? "#f64838" : "#0a0606",
                  }}
                />
                {i < STEPS.length - 1 && (
                  <span
                    className="my-1 w-0 flex-1 border-l"
                    style={
                      sleepLeg
                        ? {
                            borderLeftStyle: "dashed",
                            borderLeftColor: "#f64838",
                            opacity: 0.9,
                          }
                        : { borderLeftColor: "rgba(255,255,255,0.28)" }
                    }
                  />
                )}
              </div>
              <div className={i < STEPS.length - 1 ? "pb-5" : ""}>
                <p
                  className="font-mono text-[12px] leading-[16px]"
                  style={{
                    color: s.sleep ? "#f64838" : "rgba(255,255,255,0.75)",
                  }}
                >
                  {s.label}
                </p>
                <p className="mt-0.5 font-mono text-[10px] text-white/35">
                  {s.sub}
                </p>
                {sleepLeg && (
                  <div className="mt-3.5 rounded border border-[var(--tw-border)] bg-white/[0.03] px-3 py-2">
                    <p className="font-mono text-[10px] text-white/50">
                      deploy · worker restarts
                    </p>
                    <p className="mt-0.5 font-mono text-[10px] text-[#f64838]">
                      the wait keeps running
                    </p>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <svg
        viewBox="0 0 1000 190"
        className="hidden w-full select-none px-2 pt-2 pb-1 md:block"
        role="presentation"
      >
        <defs>
          <pattern
            id="hs-deploy-hatch"
            width="6"
            height="6"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <rect width="6" height="6" fill="rgba(255,255,255,0.03)" />
            <line
              x1="0"
              y1="0"
              x2="0"
              y2="6"
              stroke="rgba(255,255,255,0.14)"
              strokeWidth="1"
            />
          </pattern>
          <linearGradient id="hs-deploy-fade" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="white" stopOpacity="0" />
            <stop offset="0.25" stopColor="white" stopOpacity="1" />
            <stop offset="0.75" stopColor="white" stopOpacity="1" />
            <stop offset="1" stopColor="white" stopOpacity="0" />
          </linearGradient>
          <mask id="hs-deploy-mask">
            <rect
              x={DEPLOY_X - 26}
              y="18"
              width="52"
              height="156"
              fill="url(#hs-deploy-fade)"
            />
          </mask>
          <radialGradient id="hs-pulse-glow">
            <stop offset="0" stopColor="#f64838" stopOpacity="0.55" />
            <stop offset="1" stopColor="#f64838" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* deploy band — hatched seam the sleep passes straight through */}
        <g mask="url(#hs-deploy-mask)">
          <rect
            x={DEPLOY_X - 26}
            y="18"
            width="52"
            height="156"
            fill="url(#hs-deploy-hatch)"
          />
          <line
            x1={DEPLOY_X - 26}
            y1="18"
            x2={DEPLOY_X - 26}
            y2="174"
            stroke="rgba(255,255,255,0.18)"
            strokeWidth="1"
          />
          <line
            x1={DEPLOY_X + 26}
            y1="18"
            x2={DEPLOY_X + 26}
            y2="174"
            stroke="rgba(255,255,255,0.18)"
            strokeWidth="1"
          />
        </g>

        {/* executed track segments */}
        <line
          x1={STEPS[0].x}
          y1={CY}
          x2={STEPS[2].x}
          y2={CY}
          stroke="rgba(255,255,255,0.28)"
          strokeWidth="1.5"
        />
        {/* the sleep — dashed crimzon, unbroken across the deploy */}
        <line
          x1={STEPS[2].x}
          y1={CY}
          x2={STEPS[3].x}
          y2={CY}
          stroke="#f64838"
          strokeWidth="1.5"
          strokeDasharray="7 8"
          strokeLinecap="round"
          opacity="0.9"
        />
        <line
          x1={STEPS[3].x}
          y1={CY}
          x2="970"
          y2={CY}
          stroke="rgba(255,255,255,0.28)"
          strokeWidth="1.5"
        />

        {/* step nodes + labels */}
        {STEPS.map((s, i) => (
          <g key={s.label}>
            <circle
              cx={s.x}
              cy={CY}
              r="6"
              fill={s.filled ? "#f64838" : "#0a0606"}
              stroke={s.sleep ? "#f64838" : "rgba(255,255,255,0.5)"}
              strokeWidth="1.5"
            />
            {s.sleep && (
              <circle
                cx={s.x}
                cy={CY}
                r="11"
                fill="none"
                stroke="#f64838"
                strokeWidth="1"
                opacity="0.35"
              />
            )}
            <text
              x={s.x}
              y={i % 2 === 0 ? CY - 34 : CY - 58}
              textAnchor={i === 0 ? "start" : "middle"}
              className="font-mono"
              fontSize="12"
              fill={s.sleep ? "#f64838" : "rgba(255,255,255,0.75)"}
            >
              {s.label}
            </text>
            <line
              x1={s.x}
              y1={i % 2 === 0 ? CY - 26 : CY - 50}
              x2={s.x}
              y2={CY - 12}
              stroke="rgba(255,255,255,0.15)"
              strokeWidth="1"
            />
            <text
              x={s.x}
              y={CY + 30}
              textAnchor={i === 0 ? "start" : "middle"}
              className="font-mono"
              fontSize="10.5"
              fill="rgba(255,255,255,0.35)"
            >
              {s.sub}
            </text>
          </g>
        ))}

        {/* run end arrowhead */}
        <path d="M970 96 l-9 -4.5 v9 z" fill="rgba(255,255,255,0.4)" />

        {/* deploy annotation */}
        <text
          x={DEPLOY_X}
          y="42"
          textAnchor="middle"
          className="font-mono"
          fontSize="10.5"
          fill="rgba(255,255,255,0.5)"
        >
          deploy · worker restarts
        </text>
        <text
          x={DEPLOY_X}
          y={CY + 62}
          textAnchor="middle"
          className="font-mono"
          fontSize="10.5"
          fill="#f64838"
        >
          the wait keeps running
        </text>

        {/* travelling pulse riding the track */}
        <g className="hs-run-pulse">
          <circle r="14" fill="url(#hs-pulse-glow)">
            <animateMotion
              dur="8s"
              repeatCount="indefinite"
              path={`M${STEPS[0].x} ${CY} H970`}
            />
          </circle>
          <circle r="3.5" fill="#f64838">
            <animateMotion
              dur="8s"
              repeatCount="indefinite"
              path={`M${STEPS[0].x} ${CY} H970`}
            />
          </circle>
        </g>
      </svg>
    </div>
  );
}

function PsHatchet() {
  return (
    <section id="hatchet" className="relative tw-section">
      <Container className="pt-16 pb-24">
        <Reveal>
          <div className="flex items-center justify-between gap-6">
            <Eyebrow>Powered by Hatchet</Eyebrow>
            <BrandLogo
              brand="hatchet"
              height={24}
              className="shrink-0 text-white/70"
            />
          </div>
          <h2
            className={cn(
              "mt-8 max-w-[820px] font-normal text-[34px] leading-[1.15] tracking-[-0.01em] md:text-[48px] md:leading-[56px]",
              DISPLAY,
            )}
          >
            <span className="text-white">Durable execution,</span>{" "}
            <span className="text-white/40">by Hatchet.</span>
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
            , the durable execution engine underneath Hogsend. It's what lets a
            long ctx.sleep survive a deploy and resume two days later exactly
            where it left off. Hogsend builds on Hatchet rather than rolling its
            own durability.
          </p>

          <HatchetRunTimeline />

          <div className="mt-14 grid grid-cols-1 gap-y-8 border-white/10 border-t pt-8 md:grid-cols-3 md:gap-x-10">
            {HATCHET_PILLARS.map((pillar) => (
              <div key={pillar.title}>
                <h3 className="font-medium text-[15px] text-white tracking-[-0.02em]">
                  {pillar.title}
                </h3>
                <p className="mt-2 max-w-[340px] text-sm text-white/55 leading-[21px] tracking-[-0.02em]">
                  {pillar.body}
                </p>
              </div>
            ))}
          </div>
        </Reveal>
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
    <section className="relative tw-section">
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
              <div className="flex h-full flex-col justify-between rounded-lg border border-[var(--tw-border)] bg-white/[0.03] p-6">
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
        <Reveal>
          <div className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-3">
            <Link
              href="/service"
              className="text-[14px] text-white tracking-[-0.02em] underline decoration-white/30 underline-offset-4 transition-colors hover:decoration-white"
            >
              Have it built and run for you →
            </Link>
            <Link
              href="/pricing"
              className="text-[14px] text-white/50 tracking-[-0.02em] transition-colors hover:text-white/80"
            >
              Full pricing
            </Link>
          </div>
        </Reveal>
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
    <section id="use-cases" className="relative tw-section">
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
            <ThermalHover key={d.href}>
              <Link
                href={d.href}
                className="group block rounded-[6px] border border-[var(--tw-border)] p-6 transition-colors hover:border-[#f64838]/40"
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
            </ThermalHover>
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
    <section className="relative tw-section">
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
    <section className="relative overflow-hidden tw-section">
      {/* Bookend horizon: the crimzon glow the page OPENED on returns at the
          bottom edge — the scroll ends where it began, on the thermal
          horizon. Stronger than the hero's; nothing sits below but footer. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 mix-blend-screen"
        style={{
          background:
            "radial-gradient(85% 55% at 50% 108%, rgba(246,72,56,0.38) 0%, rgba(246,72,56,0.12) 45%, transparent 75%)",
        }}
      />
      <ThermalLayer strength={0.2} />
      <HalftoneOverlay className="opacity-40" />

      <Container className="relative flex flex-col items-center justify-center pt-24 text-center md:pt-32">
        <Eyebrow light>Get started</Eyebrow>
        <h2
          className={cn(
            "mt-6 max-w-[760px] text-balance font-normal text-[40px] text-white leading-[1.08] tracking-[-0.02em] md:text-[64px] md:leading-[68px]",
            DISPLAY,
          )}
        >
          First send in minutes.
        </h2>
        <p className="mt-5 max-w-[560px] text-balance text-base text-white/65 leading-[24px] tracking-[-0.02em]">
          One prompt scaffolds the app, Docker, env, and ten journeys — the
          welcome series included. Your agent reads the docs and does the rest.
        </p>

        {/* Not a shell command — a prompt for your coding agent, staged in
            the same window chrome as the hero's agent session. */}
        <div className="mt-10 flex w-full max-w-[640px] flex-col items-center">
          <ThermalHover rounded="rounded-xl" className="w-full">
            <div className="w-full overflow-hidden rounded-xl border border-white/15 bg-[#0a0606] text-left shadow-lg">
              {/* title bar — matches the hero agent-session window */}
              <div className="flex items-center justify-between gap-2 border-white/10 border-b px-4 py-2.5 sm:px-5">
                <span className="inline-flex items-center gap-2 font-mono text-[11px] text-white/40 uppercase tracking-[0.08em]">
                  <svg
                    width="9"
                    height="8"
                    viewBox="0 0 9 8"
                    aria-hidden="true"
                    className="text-[#f64838]"
                  >
                    <path d="M4.5 0L9 8H0z" fill="currentColor" />
                  </svg>
                  your agent, one prompt
                </span>
                <CopyButton
                  value={AGENT_CLOSING_PROMPT}
                  className="shrink-0 text-white/40 hover:text-white"
                />
              </div>
              <p className="flex gap-2 px-4 py-4 font-mono text-[12.5px] text-white/85 leading-[20px] tracking-[-0.01em] sm:px-5 md:text-[13.5px] md:leading-[22px]">
                <span className="shrink-0 text-[#f64838]">❯</span>
                <span className="min-w-0">{AGENT_CLOSING_PROMPT}</span>
              </p>
            </div>
          </ThermalHover>
          <p className="mt-3 font-mono text-[11px] text-white/40 uppercase tracking-[0.08em]">
            Paste into your coding agent
          </p>
        </div>
      </Container>

      {/* Where to go next — a contained link strip. Rules span the content
          column fully; column rules run cell-height with no floating gaps. */}
      <Container className="relative mt-14 px-0 md:mt-20 md:px-0">
        <nav
          aria-label="Explore Hogsend"
          className="grid grid-cols-1 border-white/10 border-t sm:grid-cols-2 lg:grid-cols-4"
        >
          {(
            [
              ["Playbook", "GTM plays with real journey code", "/playbook"],
              ["Course", "Measure → Keep → Grow", "https://course.hogsend.com"],
              [
                "How it stacks up",
                "Feature matrix vs Loops, Klaviyo & more",
                "/docs/compare/feature-matrix",
              ],
              [
                "Source-available",
                "ELv2 — read the code on GitHub",
                GITHUB_URL,
              ],
            ] as const
          ).map(([label, detail, href], i) => (
            <Link
              key={label}
              href={href}
              className={cn(
                "group/cell flex flex-col gap-1.5 px-6 py-6 text-left transition-colors hover:bg-white/[0.04] md:py-7",
                i > 0 && "border-white/10 sm:border-l",
                i === 2 && "sm:border-l-0 lg:border-l",
                i >= 2 && "border-white/10 border-t lg:border-t-0",
              )}
            >
              <span className="font-mono text-[11px] text-white/45 uppercase tracking-[0.08em]">
                {label}
              </span>
              <span className="text-[15px] text-white/85 tracking-[-0.02em]">
                {detail}{" "}
                <span
                  aria-hidden="true"
                  className="inline-block text-white/40 transition-transform group-hover/cell:translate-x-0.5 group-hover/cell:text-white"
                >
                  →
                </span>
              </span>
            </Link>
          ))}
        </nav>
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

/* ----------------------------------------------------------------- page -- */

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ hero?: string }>;
}): Promise<JSX.Element> {
  const engineVersion = await getEngineVersion();
  // Hero selection. The windowed agent session is the default; the match-day
  // stadium takes over automatically on the World Cup final (by New-York date,
  // the event's timezone). `?hero=field` restores the plain day-field hero and
  // `?hero=classic` the original thermal one, and `?hero=wired` forces the
  // default back on the one day match-day pre-empts it. Query overrides win,
  // for previewing any variant on any day. Reading searchParams/date opts this page
  // into dynamic rendering — acceptable for a hero that changes by hour and day.
  const { hero } = await searchParams;
  const nyDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
  }).format(new Date());
  const isFinalDay = nyDate === WORLD_CUP_FINAL_DATE;
  const heroVariant =
    hero === "classic"
      ? "classic"
      : hero === "matchday"
        ? "matchday"
        : hero === "field"
          ? "field"
          : hero === "wired"
            ? "wired"
            : isFinalDay
              ? "matchday"
              : "wired";
  const fieldConfig =
    heroVariant === "matchday" ? MATCHDAY_FIELD : LANDSCAPE_FIELD;
  // Fixed-time fields (the match day) paint the right frame at SSR — no flash.
  const heroInitialHour = fieldInitialHour(fieldConfig);
  // The clock + preview scrubber are a preview affordance: show them only when
  // a `?hero=` query is present, never for a normal visitor.
  const showFieldControls = hero !== undefined;
  // Shiki is an async RSC and the window stage is a client component, so every
  // file a run can write is highlighted here and handed down keyed by path.
  const heroSources = Object.fromEntries(
    Object.values(MINTED_FILES)
      .filter((file) => file.kind === "code")
      .map((file) => [
        file.path,
        <CodeHighlight key={file.path} code={file.source} lang="ts" />,
      ]),
  );
  return (
    <main className="overflow-x-clip tracking-normal">
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: static JSON-LD built from our own constants
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />
      {/* Notification bar (the live "chat to Doug" ticker) — shared with the
          interior pages; sits above the sticky nav and scrolls away with it. */}
      {heroVariant === "classic" ? (
        <>
          <AnnouncementBanner />
          <PsNav />
          <PsHero engineVersion={engineVersion} />
        </>
      ) : heroVariant === "wired" ? (
        /* The live agent session: headline beside the CLI, with each file the
           run writes minted into its own window. Same fixed glass nav over the
           hour-lit vista as the day-field hero it replaces. */
        <>
          <PsNav fixed glass />
          <WiredHeroSection
            engineVersion={engineVersion}
            highlighted={heroSources}
          />
        </>
      ) : (
        /* Day-field hero: fixed glass nav over the hour-lit backdrop (vista, or
           the match-day stadium on the final); no banner so it sits at the very
           top. The rest of the page is unchanged. */
        <>
          <PsNav fixed glass />
          <DayfieldHeroSection
            engineVersion={engineVersion}
            configId={fieldConfig.id}
            initialHour={heroInitialHour}
            controls={showFieldControls}
          />
        </>
      )}
      <PsProblem />
      <PsProofStrip />
      <PsManifesto />
      {/* Temporarily hidden: <_PsHowItWorks /> */}
      <PsAgents />
      <PsUseCases />
      <PsFeatureIndex engineVersion={engineVersion} />
      {/* Feature deep-dive stack — video through timing, back to back. */}
      <PsVideo />
      <PsFlags />
      <PsGroups />
      <PsEmailAnswers />
      <PsLinks />
      <PsDiscord />
      <PsSources />
      <PsImpact />
      <PsProductDemo />
      {/* Temporarily hidden: <_PsStats /> */}
      <PsElephant />
      <PsHatchet />
      <PsEconomics />
      <PsFaq />
      <PsClosingCta />
      <PsFooter />
      <PsFrame />
    </main>
  );
}
