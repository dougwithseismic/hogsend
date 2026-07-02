import { Bell, Mail, MessageSquare, Zap } from "lucide-react";
import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import type { JSX, ReactNode } from "react";
import { type BrandKey, BrandLogo } from "@/components/ds/brand-logo";
import { CodeHighlight } from "@/components/ds/code-highlight";
import { CopyButton } from "@/components/ds/copy-button";
import { LogoMarquee } from "@/components/ds/marquee";
import { Reveal } from "@/components/ds/reveal";
import { cn } from "@/lib/cn";
import {
  DISCORD_INVITE_URL,
  ENGINE_VERSION,
  GITHUB_URL,
  NPM_URL,
  RAILWAY_DEPLOY_URL,
} from "@/lib/site";
import studioJourneys from "@/public/images/studio/studio-journeys.png";
import studioSends from "@/public/images/studio/studio-sends.png";
import { PsBlocksTabs } from "./_components/blocks-tabs";
import {
  type ProviderValue,
  PsCodePicker,
  type UseCaseValue,
} from "./_components/code-picker";
import { WordReveal } from "./_components/word-reveal";

/* ========================================================================== */
/*  The Hogsend homepage — light crimzon design language.                     */
/*                                                                            */
/*  Developed as the /spike-polar spike (Polar Signals design-system          */
/*  exploration), promoted to the homepage 2026-07-02. Base tokens lifted     */
/*  from polarsignals.com (computed styles, 2026-07-01):                      */
/*    ink #040406 · body #2e3038 · muted #75768a · hairline #e4e4e9           */
/*    solid button #121317/#fafafa · outline 1px #2e3038 · radius 6px         */
/*    accent purple #6f5af6 (eyebrow triangles, pills, pixel art)             */
/*    display: Articulat CF 400 (stand-in: Montserrat, --ps-display)          */
/*    body: Inter 18/27 · eyebrows + badges: mono 12px uppercase              */
/*  Recurring furniture: ▲ MONO EYEBROWS, huge sentence-case display h2s      */
/*  ending in a period, two-tone headlines (ink → muted), pixel-bar gradient  */
/*  art, dot-grid decorations, dark full-bleed platform section, black       */
/*  4-column footer.                                                          */
/*                                                                            */
/*  All copy is the real homepage copy — nothing invented, no usage claims.   */
/* ========================================================================== */

export const metadata: Metadata = {
  title: {
    absolute: "Hogsend — The lifecycle email layer PostHog doesn't have yet",
  },
  description:
    "Welcome series, trial nudges, win-backs, payment saves — running from your repo on PostHog and product events, sent through your own Resend or Postmark account. Free to self-host.",
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
        light ? "text-white/80" : "text-[#040406]",
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
  children,
  className,
}: {
  href: string;
  variant?: "solid" | "outline" | "ghost";
  size?: "sm" | "lg";
  children: ReactNode;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "inline-flex items-center justify-center rounded-[6px] font-medium tracking-[-0.025em] transition-colors",
        size === "sm" ? "px-4 py-2 text-sm" : "px-5 py-3.5 text-base",
        variant === "solid" && "bg-[#121317] text-[#fafafa] hover:bg-[#2e3038]",
        variant === "outline" &&
          "border border-[#2e3038] bg-white text-[#040406] hover:bg-[#f4f4f6]",
        variant === "ghost" && "text-[#040406] hover:opacity-70",
        className,
      )}
    >
      {children}
    </Link>
  );
}

/** Inline mono pill, as in Polar's "runs on [Kubernetes]" sentence. */
function InlinePill({ children }: { children: ReactNode }) {
  return (
    <span className="mx-0.5 inline-flex translate-y-[-1px] items-center gap-1.5 rounded-full border border-[#e4e4e9] bg-white/80 px-3 py-0.5 align-middle font-mono text-[0.72em] text-[#2e3038] shadow-sm">
      {children}
    </span>
  );
}

/** Monochrome Hogsend lockup — Polar renders its mark single-colour. */
function InkLogo({ light }: { light?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
        className={cn("size-[18px]", light ? "text-white" : "text-[#040406]")}
      >
        <path d="M3.5 12 20 4.5 14 20l-3.2-6.4L3.5 12Z" fill="currentColor" />
      </svg>
      <span
        className={cn(
          "font-semibold text-[17px] leading-none tracking-[-0.02em]",
          DISPLAY,
          light ? "text-white" : "text-[#040406]",
        )}
      >
        Hogsend
      </span>
    </span>
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

/** GitHub mark (inline, from the main SiteNav treatment). */
function GitHubMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.009-.868-.014-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.31.678.921.678 1.856 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.523 2 12 2Z"
      />
    </svg>
  );
}

/** Discord mark (inline, matches the GitHub mark's treatment). */
function DiscordMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path d="M20.317 4.369a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.369a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.1 13.1 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.009c.12.099.246.198.373.292a.077.077 0 0 1-.006.127 12.3 12.3 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03ZM8.02 15.331c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418Zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418Z" />
    </svg>
  );
}

/* ------------------------------------------------------------------ nav -- */

const NAV_LINKS = [
  { label: "Use Cases", href: "/use-cases/onboarding" },
  { label: "Pricing", href: "/pricing" },
  { label: "Docs", href: "/docs" },
  { label: "Changelog", href: "/changelog" },
];

function PsNav() {
  return (
    <header className="sticky top-0 z-50 border-[#f6483833] border-b bg-white/85 backdrop-blur">
      <Container className="flex h-[54px] items-center justify-between">
        <div className="flex items-center gap-8">
          <Link href="/">
            <InkLogo />
          </Link>
          <nav className="hidden items-center gap-5 md:flex">
            {NAV_LINKS.map((l) => (
              <Link
                key={l.label}
                href={l.href}
                className="font-medium text-[#040406] text-sm tracking-[-0.025em] hover:opacity-70"
              >
                {l.label}
              </Link>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-2">
          {/* The nav bell — the real site's in-app feed entry point, here as
              a light-system visual (the live feed itself sits in the hero). */}
          <span
            aria-hidden="true"
            className="relative hidden size-8 items-center justify-center rounded-[6px] border border-[#e4e4e9] text-[#2e3038] sm:inline-flex"
          >
            <Bell className="size-4" strokeWidth={1.5} />
            <span className="absolute top-1 right-1 size-1.5 rounded-full bg-[#f64838]" />
          </span>
          <a
            href={GITHUB_URL}
            aria-label="GitHub"
            className="hidden size-8 items-center justify-center rounded-[6px] border border-[#e4e4e9] text-[#2e3038] transition-colors hover:border-[#c9c9cf] hover:text-[#040406] sm:inline-flex"
          >
            <GitHubMark className="size-4" />
          </a>
          <a
            href={DISCORD_INVITE_URL}
            aria-label="Discord"
            className="hidden size-8 items-center justify-center rounded-[6px] border border-[#e4e4e9] text-[#2e3038] transition-colors hover:border-[#c9c9cf] hover:text-[#040406] sm:inline-flex"
          >
            <DiscordMark className="size-4" />
          </a>
          <Btn href="/docs/getting-started" className="ml-1">
            Start building
          </Btn>
        </div>
      </Container>
    </header>
  );
}

/* ----------------------------------------------------------------- hero -- */

/** The live-demo window, in the light system — animated on a shared 10s
 * clock: the sign-up email types itself, then the feed cards arrive one by
 * one (the notification loop the real @hogsend/react feed shows live). */
function PsHeroDemo() {
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
    <div className="mx-auto max-w-[980px] overflow-hidden rounded-xl border border-[#dcdce2] bg-white shadow-2xl">
      {/* Window chrome */}
      <div className="flex items-center justify-between border-[#ececef] border-b px-4 py-2.5">
        <div className="flex items-center gap-3">
          <div aria-hidden="true" className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-full bg-[#e4e4e9]" />
            <span className="size-2.5 rounded-full bg-[#e4e4e9]" />
            <span className="size-2.5 rounded-full bg-[#e4e4e9]" />
          </div>
          <span className="font-mono text-[#9b9ca6] text-[11px] tracking-wide">
            hogsend.com — live demo
          </span>
        </div>
        <span className="relative inline-flex size-7 items-center justify-center rounded-[6px] border border-[#e4e4e9] text-[#2e3038]">
          <Bell className="size-3.5" strokeWidth={1.5} />
          <span className="ps-pulse -top-1 -right-1 absolute inline-flex size-4 items-center justify-center rounded-full bg-[#f64838] font-medium text-[10px] text-white">
            3
          </span>
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 md:divide-x md:divide-[#ececef]">
        {/* Left — the real sign-up, typing itself. */}
        <div className="p-6 text-left md:p-8">
          <span className="font-mono text-[#9b9ca6] text-[11px] uppercase tracking-[0.08em]">
            Get the demo
          </span>
          <h3 className="mt-3 font-medium text-[#040406] text-xl tracking-[-0.02em]">
            First name, email — get the demo.
          </h3>
          <p className="mt-2 text-[#75768a] text-sm leading-[21px] tracking-[-0.02em]">
            A stock create-hogsend app running in production ingests the event,
            runs its welcome journey, and sends from hello@hogsend.com a few
            seconds later.
          </p>
          <div className="mt-6 flex items-center gap-2 rounded-[6px] border border-[#e4e4e9] p-1.5 pl-4">
            <span className="flex-1 font-mono text-[#2e3038] text-sm">
              <span className="ps-type">sam@acme.com</span>
              <span
                aria-hidden="true"
                className="ps-caret -mb-0.5 inline-block h-4 w-px bg-[#f64838]"
              />
            </span>
            <span className="rounded-[4px] bg-[#121317] px-3.5 py-2 font-medium text-sm text-white">
              Get the demo
            </span>
          </div>
          <p className="mt-4 text-[#9b9ca6] text-[12px] leading-5 tracking-[-0.02em]">
            Same engine, same journey code you scaffold · unsubscribe is one
            click
          </p>
        </div>

        {/* Right — the in-app loop, notifications arriving live. */}
        <div className="bg-[#fafafb] p-6 text-left md:p-8">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[#9b9ca6] text-[11px] uppercase tracking-[0.08em]">
              Live feed
            </span>
            <span className="flex items-center gap-1.5 font-mono text-[#17805a] text-[11px]">
              <span className="ps-pulse size-1.5 rounded-full bg-[#23c489]" />
              connected
            </span>
          </div>
          <div className="mt-4 flex flex-col gap-2.5">
            {feed.map((n) => (
              <div
                key={n.title}
                className="ps-feed-in rounded-md border border-[#ececef] bg-white px-4 py-3"
                style={{ animationDelay: `${n.delay}s` }}
              >
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-[6px] bg-[#fdeeec] text-[#b8281c]">
                    {n.icon}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate font-medium text-[#040406] text-[13px] tracking-[-0.02em]">
                        {n.title}
                      </p>
                      <span className="flex shrink-0 items-center gap-2">
                        <span className="text-[#9b9ca6] text-[11px]">
                          {n.time}
                        </span>
                        <span className="size-1.5 rounded-full bg-[#f64838]" />
                      </span>
                    </div>
                    <p className="mt-0.5 text-[#75768a] text-[12px] leading-5 tracking-[-0.02em]">
                      {n.body}
                    </p>
                    <p className="mt-1.5 font-mono text-[#9b9ca6] text-[10px]">
                      via {n.journey}
                    </p>
                  </div>
                </div>
              </div>
            ))}
            {/* The in-email answer — the click IS the answer. */}
            <div
              className="ps-feed-in rounded-md border border-[#ececef] bg-white px-4 py-3"
              style={{ animationDelay: "7s" }}
            >
              <div className="flex items-start gap-3">
                <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-[6px] bg-[#fdeeec] text-[#b8281c]">
                  <MessageSquare className="size-3.5" strokeWidth={1.5} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-[#040406] text-[13px] tracking-[-0.02em]">
                    Quick question
                  </p>
                  <p className="mt-0.5 text-[#75768a] text-[12px] leading-5 tracking-[-0.02em]">
                    How likely are you to recommend Hogsend? The click is the
                    answer — the journey branches on it.
                  </p>
                  <div className="mt-2.5 flex items-center gap-2">
                    <span className="rounded-full bg-[#fdeeec] px-3 py-1 font-medium text-[#b8281c] text-[12px]">
                      Likely
                    </span>
                    <span className="rounded-full border border-[#e4e4e9] px-3 py-1 font-medium text-[#75768a] text-[12px]">
                      Not yet
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function PsHero() {
  return (
    <section className="relative overflow-hidden">
      <Container className="relative flex flex-col items-center pt-20 text-center md:pt-24">
        {/* Announcement pill — the lifecycle course. */}
        <a
          href="https://course.hogsend.com"
          className="inline-flex items-center gap-2 rounded-full bg-[#fdeeec] py-1 pr-4 pl-1 text-[13px] text-[#2e3038]"
        >
          <span className="rounded-full bg-[#f64838] px-2.5 py-0.5 font-medium text-[12px] text-white">
            Course
          </span>
          Measure → Keep → Grow — lifecycle marketing on PostHog + Hogsend
          <span className="font-medium text-[#040406]">Take it →</span>
        </a>

        <h1
          className={cn(
            "mt-9 max-w-[840px] font-normal text-[#040406] text-[44px] leading-[1.08] tracking-[-0.02em] md:text-[64px] md:leading-[68px]",
            DISPLAY,
          )}
        >
          Hogsend acts on what PostHog sees.
        </h1>
        <p className="mt-6 max-w-[600px] text-[#2e3038] text-lg leading-[27px] tracking-[-0.025em]">
          Lifecycle marketing as TypeScript in your repo — the welcome series,
          trial nudges, and win-backs that keep users, sent through your own
          Resend or Postmark account.
        </p>

        <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
          <Btn href="/docs/getting-started" size="lg">
            Start building
          </Btn>
          <Btn href={RAILWAY_DEPLOY_URL} variant="outline" size="lg">
            Deploy on Railway
          </Btn>
        </div>

        {/* Scaffold command — the crimzon hero's command strip, light chrome. */}
        <div className="mt-7 flex items-center gap-4 rounded-[6px] border border-[#e4e4e9] bg-[#fafafa] py-2.5 pr-3 pl-4">
          <code className="font-mono text-[13px] text-[#2e3038]">
            <span className="text-[#f64838]">$</span> {INSTALL_COMMAND}
          </code>
          <CopyButton
            value={INSTALL_COMMAND}
            className="text-[#9b9ca6] hover:text-[#040406]"
          />
        </div>
        <p className="mt-4 text-[#9b9ca6] text-sm tracking-[-0.025em]">
          Free to self-host · No per-contact billing
        </p>
      </Container>

      {/* Hero canvas — a contained ink panel carrying the crimzon
          planet-horizon glow; the live demo window floats over it. */}
      <Container className="relative mt-14">
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

      <Container className="-mt-[210px] relative z-10 pb-14 md:-mt-[230px]">
        <PsHeroDemo />
        <p className="mt-5 text-center text-[#9b9ca6] text-[13px] tracking-[-0.02em]">
          The feed, bell, and survey card are real{" "}
          <code className="font-mono text-[#2e3038]">@hogsend/react</code>{" "}
          components — live on hogsend.com.{" "}
          <Link href="/components" className="font-medium text-[#040406]">
            See the full set →
          </Link>
        </p>
      </Container>

      {/* Works-with strip */}
      <div className="border-[#f6483833] border-y">
        <Container className="flex flex-col gap-5 py-9 md:flex-row md:items-center md:gap-12">
          <span className="shrink-0 font-mono text-[#9b9ca6] text-[12px] uppercase tracking-[0.08em]">
            Works with
          </span>
          <div className="relative min-w-0 flex-1 opacity-70 grayscale">
            <LogoMarquee
              items={(
                [
                  "posthog",
                  "resend",
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
                  className="mx-8 text-[#75768a]"
                />
              ))}
            />
          </div>
        </Container>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------ proof strip -- */

/** Mintlify's counters band, restated with our verifiable proof inventory —
 * releases/packages/templates/journeys, never invented usage numbers. */
function PsProofStrip() {
  const stats = [
    { label: "Current release", value: `v${ENGINE_VERSION}` },
    { label: "Packages on npm", value: "11" },
    { label: "React Email templates", value: "13" },
    { label: "Journeys in the scaffold", value: "10" },
  ];
  return (
    <div className="border-[#f6483833] border-b">
      <Container className="flex flex-wrap items-center gap-x-8 gap-y-3 py-4">
        <span className="font-mono text-[#9b9ca6] text-[12px] uppercase tracking-[0.08em]">
          In the open
        </span>
        {stats.map((stat) => (
          <span
            key={stat.label}
            className="flex items-center gap-2.5 text-[13px] text-[#75768a] tracking-[-0.02em]"
          >
            {stat.label}
            <span className="rounded-[4px] bg-[#fdeeec] px-1.5 py-0.5 font-mono text-[#b8281c] text-[12px]">
              {stat.value}
            </span>
          </span>
        ))}
        <Link
          href={NPM_URL}
          className="ml-auto font-medium text-[#040406] text-[13px] tracking-[-0.02em] hover:opacity-70"
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
    <span className="inline-flex size-[46px] items-center justify-center border border-[#d6d6dc] bg-white">
      <svg
        viewBox="0 0 32 32"
        fill="none"
        stroke="#040406"
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
        <Eyebrow>The problem</Eyebrow>

        <div className="mt-8 flex flex-col justify-between gap-10 lg:flex-row">
          <h2
            className={cn(
              "max-w-[560px] font-normal text-[38px] leading-[1.12] tracking-[-0.02em] md:text-[56px] md:leading-[63px]",
              DISPLAY,
            )}
          >
            {/* Scroll-linked word reveal — the homepage Manifesto animation,
                re-keyed to the light palette. */}
            <WordReveal text="Hogsend is the lifecycle layer in your repo — the welcome, the nudge, the win-back." />
          </h2>

          <div className="max-w-[340px] lg:pt-2">
            <p className="text-[#2e3038] text-base leading-[24px] tracking-[-0.025em]">
              PostHog shows you where users drop off; acting on it meant buying
              a second platform and syncing your data into it. Hogsend deletes
              that step — journeys are TypeScript, triggered by the events you
              already have.{" "}
              <Link href="/docs" className="font-medium text-[#040406]">
                Learn more →
              </Link>
            </p>
            <div className="mt-6 flex items-center gap-6 opacity-80 grayscale">
              <BrandLogo
                brand="posthog"
                height={18}
                className="text-[#2e3038]"
              />
              <BrandLogo
                brand="resend"
                height={16}
                className="text-[#2e3038]"
              />
              <BrandLogo
                brand="typescript"
                height={18}
                className="text-[#2e3038]"
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
        <p className="mt-20 max-w-[420px] text-[#040406] text-lg leading-[26px] tracking-[-0.025em]">
          Build retention without buying and babysitting a second marketing
          platform.
        </p>
        <div className="mt-10 grid grid-cols-1 gap-10 md:grid-cols-3">
          {PILLARS.map((p, i) => (
            <div key={p.title}>
              <PillarIcon index={i} />
              <h3 className="mt-5 font-medium text-[#040406] text-base tracking-[-0.025em]">
                {p.title}
              </h3>
              <p className="mt-2 max-w-[300px] text-[#75768a] text-sm leading-[21px] tracking-[-0.02em]">
                {p.body}
              </p>
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
            <span className="text-[#040406]">
              Every signal lands on one person.
            </span>{" "}
            <span className="text-[#9b9ca6]">
              Every event can fan back out.
            </span>
          </h2>
          <p className="mt-6 max-w-[560px] text-[#75768a] text-base leading-[24px] tracking-[-0.02em]">
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
                style={{ background: i % 2 === 0 ? "#f6f7fb" : "#fdf1ee" }}
              >
                <span className="font-mono text-[#b8281c] text-[11px] uppercase tracking-[0.08em]">
                  {s.tag}
                </span>
                <p className="mt-3 text-[14.5px] leading-[22px] tracking-[-0.02em]">
                  <span className="font-medium text-[#040406]">{s.lead}</span>{" "}
                  <span className="text-[#75768a]">{s.rest}</span>
                </p>
              </div>
            ))}
          </div>
        </div>
      </Container>

      {/* Agents read the words, not just the events. */}
      <Container className="pb-24">
        <Reveal>
          <div className="mt-10 grid grid-cols-1 gap-10 border-[#ececef] border-t pt-10 lg:grid-cols-[1fr_1.4fr]">
            <div>
              <h3
                className={cn(
                  "max-w-[340px] text-[#040406] text-[26px] leading-[1.2] tracking-[-0.02em]",
                  DISPLAY,
                )}
              >
                Agents read the words, not just the events.
              </h3>
              <p className="mt-4 max-w-[360px] text-[#75768a] text-sm leading-[21px] tracking-[-0.02em]">
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
                  className={cn("py-4", i > 0 && "border-[#ececef] border-t")}
                >
                  <p className="text-[15px] leading-[23px] tracking-[-0.02em]">
                    <span className="font-medium text-[#040406]">
                      {item.lead}
                    </span>{" "}
                    <span className="text-[#75768a]">{item.rest}</span>
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

function PsStats() {
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
            <span className="text-[#040406]">
              Lifecycle email is the highest-leverage system
            </span>{" "}
            <span className="text-[#9b9ca6]">most teams skip.</span>
          </h2>
        </Reveal>

        {/* Flint's stat-card row: big numeral, caption, source chip. */}
        <div className="mt-12 grid grid-cols-1 gap-4 md:grid-cols-3">
          {BENCHMARKS.map((b, i) => (
            <Reveal key={b.source} delay={i * 0.08}>
              <div className="flex h-full flex-col rounded-lg border border-[#ececef] bg-white p-6">
                <span
                  className={cn(
                    "text-[#040406] text-[44px] leading-[1.1] tracking-[-0.02em]",
                    DISPLAY,
                  )}
                >
                  {b.value}
                </span>
                <p className="mt-2 max-w-[280px] text-[#75768a] text-sm leading-[21px] tracking-[-0.02em]">
                  {b.claim}
                </p>
                <span className="mt-6 inline-flex w-fit items-center rounded-full bg-[#fdeeec] px-3 py-1 font-mono text-[11px] text-[#b8281c] uppercase tracking-[0.06em]">
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
    bg: "radial-gradient(130% 110% at 10% 110%, #f2503c 0%, #f9a394 45%, #fff5f3 80%)",
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
    bg: "radial-gradient(130% 120% at 50% 120%, #23c489 0%, #9fe8c4 45%, #f2fcf7 80%)",
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
    bg: "radial-gradient(130% 110% at 90% 110%, #3f68f2 0%, #8fb0ff 45%, #f4f7ff 80%)",
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

function PsAgents() {
  return (
    <section className="relative border-[#f6483826] border-t">
      <Container className="pt-16 pb-24">
        <Eyebrow>Agent-native</Eyebrow>
        <h2
          className={cn(
            "mt-8 max-w-[860px] font-normal text-[#040406] text-[38px] leading-[1.12] tracking-[-0.01em] md:text-[56px] md:leading-[63px]",
            DISPLAY,
          )}
        >
          Agents can write all of it — your review process still applies.
        </h2>

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
              <h3 className="font-medium text-[#040406] text-lg tracking-[-0.025em]">
                {c.title}
              </h3>
              <p className="mt-2 min-h-[84px] max-w-[330px] text-[#2e3038]/80 text-sm leading-[21px] tracking-[-0.02em]">
                {c.body}
              </p>
              <div className="mt-8">{c.mock}</div>
            </div>
          ))}
        </div>

        <div className="mt-10 flex flex-col justify-between gap-6 border-[#ececef] border-t pt-8 lg:flex-row lg:items-center">
          <p className="max-w-[420px] text-[#2e3038] text-base tracking-[-0.025em]">
            LLMs write and modify journeys like any other code in your repo
          </p>
          <div className="flex flex-wrap items-center gap-2.5">
            {AGENT_CHIPS.map((chip) => (
              <span
                key={chip}
                className="inline-flex items-center gap-2 rounded-[6px] border border-[#e4e4e9] bg-white px-4 py-2 font-medium text-[#040406] text-sm tracking-[-0.025em] shadow-sm"
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

        {/* The Flint prompt-card idiom: an agent ask, sitting on a soft
            two-colour blob glow. */}
        <Reveal delay={0.1}>
          <div className="relative mx-auto mt-16 max-w-[620px]">
            <div
              aria-hidden="true"
              className="-inset-x-16 -inset-y-10 pointer-events-none absolute"
              style={{
                background:
                  "radial-gradient(45% 60% at 30% 60%, rgba(246,72,56,0.16), transparent 70%), radial-gradient(40% 55% at 75% 40%, rgba(35,196,137,0.14), transparent 70%)",
                filter: "blur(24px)",
              }}
            />
            <div className="relative rounded-xl border border-[#e4e4e9] bg-white p-5 shadow-lg">
              <span className="inline-flex items-center gap-2 rounded-md border border-[#d9f2e6] bg-[#f2fcf7] px-2.5 py-1 font-mono text-[11px] text-[#17805a]">
                <span aria-hidden="true" className="size-2 bg-[#23c489]" />
                src/journeys/winback.ts
              </span>
              <p className="mt-3 text-[#2e3038] text-[17px] leading-[26px] tracking-[-0.02em]">
                Add a win-back journey: trigger when someone enters the
                went-dormant bucket, check in, wait 7 days, then send the offer.
                Exit the moment they come back.
              </p>
              <div className="mt-4 flex items-center justify-between">
                <div className="flex items-center gap-2 text-[#9b9ca6]">
                  <span className="inline-flex size-7 items-center justify-center rounded-[6px] border border-[#e4e4e9] font-mono text-[11px]">
                    @
                  </span>
                  <span className="inline-flex size-7 items-center justify-center rounded-[6px] border border-[#e4e4e9] font-mono text-[11px]">
                    ⌘
                  </span>
                </div>
                <span className="inline-flex size-8 items-center justify-center rounded-full bg-[#121317] text-white">
                  ↑
                </span>
              </div>
            </div>
            <p className="relative mt-4 text-center font-mono text-[#9b9ca6] text-[12px] tracking-[-0.01em]">
              hogsend skills give agents the context — your type-checker
              validates the result
            </p>
          </div>
        </Reveal>
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
  const [onboarding, trialConversion, winback, resendEnv, postmarkEnv] =
    await Promise.all([
      CodeHighlight({ code: JOURNEY_SAMPLES.onboarding, lang: "ts" }),
      CodeHighlight({ code: JOURNEY_SAMPLES.trial_conversion, lang: "ts" }),
      CodeHighlight({ code: JOURNEY_SAMPLES.winback, lang: "ts" }),
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
            <span className="text-[#040406]">
              Pick a use case, read the journey.
            </span>{" "}
            <span className="text-[#9b9ca6]">
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
            }}
            envs={{ resend: resendEnv, postmark: postmarkEnv }}
            raw={JOURNEY_SAMPLES}
          />
        </Reveal>
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
    <div className="rounded-2xl border border-[#ececef] bg-[#fafafb] p-6">
      <span className="font-mono text-[#9b9ca6] text-[11px] tracking-wide">
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
                      ? "bg-[#040406]"
                      : "border-2 border-[#c9c9cf] bg-white",
                )}
              />
              {i < steps.length - 1 && (
                <span className="my-1 w-px flex-1 bg-[#dcdce2]" />
              )}
            </div>
            <div className="pb-5">
              <p className="font-mono text-[#040406] text-[13px]">{s.label}</p>
              <p className="mt-0.5 font-mono text-[#9b9ca6] text-[11px]">
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

function PsHowItWorks() {
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
                "mt-8 font-normal text-[#040406] text-[38px] leading-[1.12] tracking-[-0.02em] md:text-[48px] md:leading-[54px]",
                DISPLAY,
              )}
            >
              The whole job is one loop.
            </h2>
            <p className="mt-6 max-w-[420px] text-[#75768a] text-base leading-[24px] tracking-[-0.02em]">
              Activity comes in from PostHog or any webhook, the right emails go
              out through your provider, and what people do with them fans back
              out to your tools. Nothing new to buy or keep in sync.
            </p>
          </div>

          <div className="flex flex-col">
            {HOW_STEPS.map((step, i) => (
              <Reveal key={step.n}>
                <div
                  className={cn("py-10", i > 0 && "border-[#ececef] border-t")}
                >
                  <span className="font-mono text-[#b8281c] text-[13px]">
                    {step.n}
                  </span>
                  <h3
                    className={cn(
                      "mt-3 text-[#040406] text-[24px] leading-[1.2] tracking-[-0.02em]",
                      DISPLAY,
                    )}
                  >
                    {step.title}
                  </h3>
                  <p className="mt-3 max-w-[520px] text-[#75768a] text-sm leading-[21px] tracking-[-0.02em]">
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
            <span className="text-[#040406]">What it does,</span>{" "}
            <span className="text-[#9b9ca6]">
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
              "radial-gradient(60% 55% at 50% 42%, #fdf0cf 0%, rgba(253,240,207,0.65) 28%, rgba(246,110,88,0.38) 62%, rgba(246,110,88,0.1) 85%, transparent 100%)",
          }}
        />
        <div className="relative flex flex-col items-center pt-28 pb-32 text-center">
          <Eyebrow>Instant setup</Eyebrow>
          <h2
            className={cn(
              "mt-8 max-w-[880px] font-normal text-[#040406] text-[40px] leading-[1.12] tracking-[-0.02em] md:text-[64px] md:leading-[72px]",
              DISPLAY,
            )}
          >
            Run a single command to ship your first journey immediately.
          </h2>

          <div className="mt-12 flex items-center gap-4 rounded-[6px] bg-[#101014] py-3.5 pr-4 pl-5 shadow-xl">
            <code className="font-mono text-[13.5px] text-white/90">
              <span className="text-white/40">$ </span>
              {INSTALL_COMMAND}
            </code>
            <CopyButton value={INSTALL_COMMAND} />
          </div>

          <p className="mt-20 max-w-[760px] text-[#2e3038] text-[22px] leading-[38px] tracking-[-0.02em] md:text-[26px] md:leading-[44px]">
            A thin TypeScript app that triggers on{" "}
            <InlinePill>PostHog</InlinePill> events, sends through{" "}
            <InlinePill>Resend</InlinePill> or <InlinePill>Postmark</InlinePill>
            , and deploys to <InlinePill>Railway</InlinePill> in one click — ten
            journeys in the scaffold, first send in minutes.
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
        <div className="relative overflow-hidden rounded-2xl bg-[#060608] p-8 text-white md:p-12">
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
                "linear-gradient(105deg, #f8b8ab 0%, #fde3dc 55%, rgba(255,255,255,0) 100%)",
            }}
          />
          <DotPatch className="bottom-8 left-8 h-28 w-56 opacity-70" />
          <div className="relative grid grid-cols-1 gap-14 p-8 md:p-12 lg:grid-cols-2">
            <div>
              <Eyebrow>In the open</Eyebrow>
              <h2
                className={cn(
                  "mt-8 max-w-[420px] font-normal text-[#040406] text-[38px] leading-[1.12] tracking-[-0.02em] md:text-[56px] md:leading-[63px]",
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
                    i > 0 && "border-[#ececef] border-t",
                  )}
                >
                  <p
                    className={cn(
                      "min-w-[260px] text-[#040406] text-lg tracking-[-0.025em]",
                      DISPLAY,
                    )}
                  >
                    {row.label}
                  </p>
                  {row.detail && (
                    <p className="border-[#dcdce2] text-[#75768a] text-sm leading-[21px] tracking-[-0.02em] md:border-l md:pl-6">
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
    tint: "#fdf1ee",
  },
  {
    lead: "In-email answers branch the journey.",
    rest: "Ask a question inside the email — the click is the answer, and the journey branches on it.",
    tint: "#f6f7fb",
  },
  {
    lead: "First-party opens and clicks.",
    rest: "Links are rewritten on send; engagement lands on your domain and fans back to PostHog as first-party events.",
    tint: "#fdf1ee",
  },
  {
    lead: "Buckets are live groups of people.",
    rest: "Contacts enter and leave on behaviour — kick off journeys on either edge.",
    tint: "#f6f7fb",
  },
  {
    lead: "Events fan out, durably.",
    rest: "A fixed 13-event catalog goes back out to PostHog, Segment, Slack, or any signed webhook — with retries, backoff, and a dead-letter queue.",
    tint: "#fdf1ee",
  },
  {
    lead: "Provider is config, not code.",
    rest: "EMAIL_PROVIDER=postmark swaps the wire underneath — the journey doesn't change.",
    tint: "#f6f7fb",
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
            <span className="text-[#040406]">
              Your lifecycle logic, however it branches,
            </span>{" "}
            <span className="text-[#9b9ca6]">
              supported by primitives built for production.
            </span>
          </h2>
          <div className="hidden shrink-0 items-center gap-2 pb-2 md:flex">
            <span className="inline-flex size-10 items-center justify-center rounded-[6px] border border-[#e4e4e9] text-[#9b9ca6]">
              ←
            </span>
            <span className="inline-flex size-10 items-center justify-center rounded-[6px] border border-[#c9c9cf] text-[#040406]">
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
                  <span className="font-medium text-[#040406]">{c.lead}</span>{" "}
                  <span className="text-[#75768a]">{c.rest}</span>
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
    <div className="rounded-2xl border border-[#ececef] bg-white p-6 shadow-sm">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[#9b9ca6] text-[11px] uppercase tracking-[0.08em]">
          First-party tracking
        </span>
        <span className="flex items-center gap-1.5 font-mono text-[#17805a] text-[11px]">
          <span className="ps-pulse size-1.5 rounded-full bg-[#23c489]" />
          live
        </span>
      </div>

      <div className="mt-5 grid grid-cols-1 items-center gap-4 sm:grid-cols-[1fr_minmax(150px,220px)_auto]">
        {/* The email, links rewritten on send. */}
        <div className="rounded-lg border border-[#ececef] bg-[#fafafb] p-4">
          <p className="font-mono text-[#9b9ca6] text-[11px]">
            from: hello@yourapp.com
          </p>
          <p className="mt-1.5 font-medium text-[#040406] text-[13px] tracking-[-0.02em]">
            Welcome — one thing to try first
          </p>
          <div className="mt-2.5 space-y-1.5">
            <div className="h-1.5 w-11/12 rounded bg-[#e9e9ee]" />
            <div className="h-1.5 w-3/4 rounded bg-[#e9e9ee]" />
          </div>
          <p className="mt-3 font-medium text-[13px] text-[#b8281c] underline decoration-[#f64838]/40 underline-offset-2 tracking-[-0.02em]">
            View your dashboard →
          </p>
          <p className="mt-2 font-mono text-[#9b9ca6] text-[10px]">
            links rewritten on send · opens pixel injected
          </p>
        </div>

        {/* Travel lane. */}
        <div className="relative hidden h-28 [--ps-lane:110px] sm:block md:[--ps-lane:150px]">
          <div
            aria-hidden="true"
            className="absolute inset-y-2 left-1/2 border-[#ececef] border-l border-dashed"
          />
          {pills.map((pill) => (
            <span
              key={pill.label}
              className={cn(
                "ps-travel absolute left-0 rounded-full border border-[#f64838]/30 bg-[#fdeeec] px-2.5 py-1 font-mono text-[#b8281c] text-[10.5px]",
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
              className="ps-arrive rounded-[6px] border border-[#ececef] bg-white px-3 py-2 font-mono text-[#2e3038] text-[11.5px]"
              style={{ animationDelay: `${d.delay}s` }}
            >
              {d.label}
            </span>
          ))}
        </div>
      </div>

      <p className="mt-4 font-mono text-[#9b9ca6] text-[10.5px]">
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
          <Eyebrow>Built on PostHog</Eyebrow>
          <h2
            className={cn(
              "mt-8 max-w-[820px] font-normal text-[34px] leading-[1.15] tracking-[-0.01em] md:text-[48px] md:leading-[56px]",
              DISPLAY,
            )}
          >
            <span className="text-[#040406]">
              Everything here makes PostHog better.
            </span>{" "}
            <span className="text-[#9b9ca6]">
              No second pipeline, no reverse-ETL.
            </span>
          </h2>
        </Reveal>

        <div className="mt-14 grid grid-cols-1 gap-12 lg:grid-cols-2">
          <div className="flex flex-col">
            {LOOP_ITEMS.map((item, i) => (
              <div
                key={item.title}
                className={cn("py-5", i > 0 && "border-[#ececef] border-t")}
              >
                <h3 className="flex items-center gap-3 font-medium text-[#040406] text-[15px] tracking-[-0.02em]">
                  <span
                    aria-hidden="true"
                    className="size-2 shrink-0 bg-[#f64838]"
                  />
                  {item.title}
                </h3>
                <p className="mt-1.5 pl-5 text-[#75768a] text-sm leading-[21px] tracking-[-0.02em]">
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
            <span className="text-[#040406]">What the repo gives you.</span>{" "}
            <span className="text-[#9b9ca6]">
              The habits that make software dependable.
            </span>
          </h2>
        </Reveal>
        <div className="mt-12 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {LESSONS.map((lesson, i) => (
            <Reveal key={lesson.label} delay={(i % 3) * 0.06}>
              <div className="flex h-full flex-col rounded-lg border border-[#ececef] bg-white p-6">
                <span className="font-mono text-[#b8281c] text-[11px] uppercase tracking-[0.08em]">
                  {lesson.label}
                </span>
                <h3 className="mt-3 font-medium text-[#040406] text-[15px] tracking-[-0.02em]">
                  {lesson.title}
                </h3>
                <p className="mt-2 text-[#75768a] text-sm leading-[21px] tracking-[-0.02em]">
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
        <div className="relative overflow-hidden rounded-2xl bg-[#060608] p-8 text-white md:p-12">
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
            <span className="text-[#040406]">What it costs.</span>{" "}
            <span className="text-[#9b9ca6]">
              Contact count appears in neither bill.
            </span>
          </h2>
          <p className="mt-6 max-w-[620px] text-[#75768a] text-base leading-[24px] tracking-[-0.02em]">
            There is no paid tier. You pay for hosting — the Railway template
            provisions Postgres, Redis, Hatchet, the API, and the worker — and
            for your own Resend or Postmark account.
          </p>
        </Reveal>

        <div className="mt-12 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {/* Hogsend — the highlighted card, detail rows pinned bottom. */}
          <Reveal className="h-full">
            <div className="relative flex h-full flex-col justify-between overflow-hidden rounded-lg border border-[#f64838]/40 bg-[#fef4f2] p-6">
              <span
                aria-hidden="true"
                className="absolute top-2 right-2 size-[10px] bg-[#f64838]"
              />
              <div>
                <span className="font-mono text-[#b8281c] text-[11px] uppercase tracking-[0.08em]">
                  Hogsend
                </span>
                <span
                  className={cn(
                    "mt-3 block text-[#040406] text-[24px] leading-[1.15] tracking-[-0.02em]",
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
                    <span className="font-mono text-[#9b6f68] text-[11px]">
                      {row.key}
                    </span>
                    <span className="text-right font-medium text-[#040406] text-[13px] tracking-[-0.02em]">
                      {row.value}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </Reveal>
          {RENT_MODELS.map((m, i) => (
            <Reveal key={m.name} delay={(i + 1) * 0.06} className="h-full">
              <div className="flex h-full flex-col justify-between rounded-lg border border-[#ececef] bg-white p-6">
                <div>
                  <span className="font-mono text-[#9b9ca6] text-[11px] uppercase tracking-[0.08em]">
                    {m.name}
                  </span>
                  <span
                    className={cn(
                      "mt-3 block text-[#2e3038] text-[20px] leading-[1.2] tracking-[-0.02em]",
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
                        j > 0 && "border-[#f2f2f5] border-t",
                      )}
                    >
                      <span className="font-mono text-[#9b9ca6] text-[11px]">
                        {row.key}
                      </span>
                      <span className="text-right text-[#2e3038] text-[13px] tracking-[-0.02em]">
                        {row.value}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </Reveal>
          ))}
        </div>
        <p className="mt-6 text-[#9b9ca6] text-[12px] tracking-[-0.02em]">
          *Published pricing, checked June 2026.
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
  },
  {
    title: "Activation nudge",
    body: "Drive the one action most correlated with sticking around — before the trial clock runs out.",
  },
  {
    title: "Feature adoption",
    body: "Most churn is a feature users never found. Surface the one they're missing.",
  },
  {
    title: "Trials that convert",
    body: "Match the ask to how much they've really used, not the day on the calendar.",
  },
  {
    title: "Payment saves",
    body: "Involuntary churn is the biggest leak you can plug. Remind, and stop the moment it clears.",
  },
  {
    title: "Win-backs",
    body: "You already paid to acquire them once — winning them back costs a fraction of a new signup.",
  },
  {
    title: "Milestones",
    body: "Celebrate progress and reinforce the habit at the moments value actually lands.",
  },
  {
    title: "Referrals",
    body: "Ask for the referral at the moment value lands, when they're most likely to say yes.",
  },
];

function PsUseCases() {
  return (
    <section className="relative border-[#f6483826] border-t">
      <Container className="pt-16 pb-28">
        <Eyebrow>Use cases</Eyebrow>
        <h2
          className={cn(
            "mt-8 max-w-[760px] font-normal text-[34px] leading-[1.15] tracking-[-0.01em] md:text-[48px] md:leading-[56px]",
            DISPLAY,
          )}
        >
          <span className="text-[#040406]">
            The emails every product should send
          </span>{" "}
          <span className="text-[#9b9ca6]">— ten ship in the scaffold.</span>
        </h2>

        {/* The event-fanning card idiom: tinted panels, lead + gray rest. */}
        <div className="mt-14 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {USE_CASES.map((u, i) => (
            <div
              key={u.title}
              className="p-6"
              style={{ background: i % 2 === 0 ? "#f6f7fb" : "#fdf1ee" }}
            >
              <p className="text-[14.5px] leading-[22px] tracking-[-0.02em]">
                <span className="font-medium text-[#040406]">{u.title}.</span>{" "}
                <span className="text-[#75768a]">{u.body}</span>
              </p>
            </div>
          ))}
        </div>
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
    a: "It uses it. Hogsend is the orchestration layer — journeys, segments, suppression, tracking — and sends through your own Resend account by default, with Postmark as a one-env-var swap.",
  },
  {
    q: "Do I need PostHog to use Hogsend?",
    a: "No. PostHog is the best-supported source, but events can come from Stripe, Clerk, Supabase, or Segment via signed webhook presets, from your own app via the Data API, or from any custom webhook source.",
  },
  {
    q: "Will my emails survive a deploy mid-journey?",
    a: "Yes. Journeys run as Hatchet durable tasks: a user three days into a seven-day wait keeps waiting through deploys, restarts, and crashes, and resumes exactly where they were.",
  },
  {
    q: "Can AI agents write Hogsend journeys?",
    a: "Yes — journeys are plain TypeScript files, so Claude Code or Cursor can write and modify them like any other code. Your type-checker validates them.",
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
                "radial-gradient(45% 45% at 40% 35%, rgba(253,240,207,0.9), transparent 70%), radial-gradient(40% 45% at 65% 65%, rgba(246,72,56,0.22), transparent 70%), radial-gradient(30% 35% at 30% 75%, rgba(246,140,110,0.2), transparent 70%)",
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
              <span className="text-[#040406]">Find what you need</span>
              <span className="text-[#9b9ca6]">.</span>
            </h2>
          </div>
        </div>

        <div>
          {FAQ.map((item, i) => (
            <details
              key={item.q}
              className={cn(
                "group border-[#ececef] border-b",
                i === 0 && "border-t",
              )}
            >
              <summary className="flex cursor-pointer list-none items-center justify-between gap-6 py-6 [&::-webkit-details-marker]:hidden">
                <span className="font-medium text-[#040406] text-base tracking-[-0.025em] md:text-lg">
                  {item.q}
                </span>
                <span
                  aria-hidden="true"
                  className="shrink-0 text-[#9b9ca6] text-xl transition-transform group-open:rotate-45"
                >
                  +
                </span>
              </summary>
              <p className="max-w-[820px] pb-6 text-[#75768a] text-base leading-[24px] tracking-[-0.02em]">
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
              <Btn
                href="/docs/getting-started"
                size="lg"
                className="bg-white text-[#121317] hover:bg-white/85"
              >
                Start building
              </Btn>
              <Btn
                href={RAILWAY_DEPLOY_URL}
                variant="outline"
                size="lg"
                className="border-white/30 bg-transparent text-white hover:bg-white/10"
              >
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
    <footer className="bg-[#060608] text-white">
      <Container className="grid grid-cols-1 gap-14 py-20 lg:grid-cols-[1.2fr_2fr]">
        <div>
          <InkLogo light />
          <p className="mt-6 text-sm text-white/60 tracking-[-0.02em]">
            Marketing automation for teams that code
          </p>
          <p className="mt-2 text-sm text-white/40 tracking-[-0.02em]">
            © 2026 Hogsend. All rights reserved.
          </p>
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

export default function HomePage(): JSX.Element {
  return (
    <main className="tracking-normal">
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: static JSON-LD built from our own constants
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />
      <PsNav />
      <PsHero />
      <PsProofStrip />
      <PsProblem />
      <PsFanning />
      <PsStats />
      <PsAgents />
      <PsCode />
      <PsSetup />
      <PsCorePlatform />
      <PsHowItWorks />
      <PsBuildingBlocks />
      <PsOpen />
      <PsFeatures />
      <PsLoop />
      <PsRepo />
      <PsHatchet />
      <PsEconomics />
      <PsUseCases />
      <PsFaq />
      <PsClosingCta />
      <PsFooter />
      <PsFrame />
    </main>
  );
}
