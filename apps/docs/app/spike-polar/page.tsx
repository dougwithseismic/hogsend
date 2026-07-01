import Image from "next/image";
import Link from "next/link";
import type { JSX, ReactNode } from "react";
import { type BrandKey, BrandLogo } from "@/components/ds/brand-logo";
import { CopyButton } from "@/components/ds/copy-button";
import { cn } from "@/lib/cn";
import { GITHUB_URL, NPM_URL, RAILWAY_DEPLOY_URL } from "@/lib/site";
import studioJourneys from "@/public/images/studio/studio-journeys.png";
import studioSends from "@/public/images/studio/studio-sends.png";

/* ========================================================================== */
/*  SPIKE — the Hogsend homepage re-set in the Polar Signals design system.   */
/*                                                                            */
/*  Tokens lifted from polarsignals.com (computed styles, 2026-07-01):        */
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
        className="text-[#6f5af6]"
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

/** Deterministic pixel-bar art (the Polar hero/footer gradient bars). */
function PixelBars({
  count = 56,
  className,
}: {
  count?: number;
  className?: string;
}) {
  const bars = Array.from({ length: count }, (_, i) => ({
    h: 10 + ((i * 53 + 17) % 86),
    o: 0.3 + ((i * 29 + 7) % 55) / 100,
  }));
  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none flex items-end gap-[7px] overflow-hidden",
        className,
      )}
    >
      {bars.map((b, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: static deterministic art
          key={i}
          className="w-[11px] shrink-0 bg-white"
          style={{ height: `${b.h}%`, opacity: b.o }}
        />
      ))}
    </div>
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
          "radial-gradient(rgba(111,90,246,0.45) 1.2px, transparent 1.2px)",
        backgroundSize: "9px 9px",
      }}
    />
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
    <header className="sticky top-0 z-50 border-[#ececef] border-b bg-white/85 backdrop-blur">
      <Container className="flex h-[54px] items-center justify-between">
        <div className="flex items-center gap-8">
          <Link href="/spike-polar">
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
        <div className="flex items-center gap-3">
          <a
            href={GITHUB_URL}
            className="hidden font-medium text-[#040406] text-sm tracking-[-0.025em] hover:opacity-70 sm:inline"
          >
            GitHub
          </a>
          <Btn href={RAILWAY_DEPLOY_URL} variant="outline">
            Deploy on Railway
          </Btn>
          <Btn href="/docs/getting-started">Start building</Btn>
        </div>
      </Container>
    </header>
  );
}

/* ----------------------------------------------------------------- hero -- */

function PsHero() {
  return (
    <section className="relative overflow-hidden">
      <Container className="pt-20 pb-10 md:pt-24">
        {/* Announcement pill */}
        <Link
          href="/changelog"
          className="inline-flex items-center gap-2 rounded-full bg-[#f1eefe] py-1 pr-4 pl-1 text-[13px] text-[#2e3038]"
        >
          <span className="rounded-full bg-[#6f5af6] px-2.5 py-0.5 font-medium text-[12px] text-white">
            New
          </span>
          Postmark support — swap providers with one env var
          <span className="text-[#75768a]">·</span>
          <span className="font-medium text-[#040406]">Learn more →</span>
        </Link>

        <div className="mt-10 flex flex-col justify-between gap-10 lg:flex-row lg:items-end">
          <div>
            <h1
              className={cn(
                "max-w-[640px] font-normal text-[#040406] text-[40px] leading-[1.12] tracking-[-0.02em] md:text-[48px] md:leading-[54px]",
                DISPLAY,
              )}
            >
              What PostHog sees, Hogsend acts on.
            </h1>
            <p className="mt-6 max-w-[440px] text-[#2e3038] text-lg leading-[27px] tracking-[-0.025em]">
              Welcome series, trial nudges, win-backs — lifecycle emails as
              TypeScript in your repo, sent through your own Resend or Postmark
              account.
            </p>
          </div>

          <div className="flex shrink-0 flex-col items-start gap-3 lg:items-end">
            <div className="flex items-center gap-3">
              <Btn href="/docs/getting-started" size="lg">
                Start building
              </Btn>
              <Btn href={RAILWAY_DEPLOY_URL} variant="outline" size="lg">
                Deploy on Railway
              </Btn>
            </div>
            <p className="text-[#75768a] text-sm tracking-[-0.025em]">
              Free to self-host · No per-contact billing
            </p>
          </div>
        </div>
      </Container>

      {/* Hero canvas — the pixel-bar gradient band. */}
      <div className="relative mt-12 h-[300px] w-full overflow-hidden md:h-[380px]">
        <div
          aria-hidden="true"
          className="absolute inset-0"
          style={{
            background:
              "linear-gradient(112deg, #c7d4fb 0%, #7d9bf7 34%, #5f7ef2 55%, #a58ef8 78%, #e9e4fd 100%)",
          }}
        />
        <PixelBars count={96} className="absolute inset-x-0 bottom-0 h-full" />
        <div
          aria-hidden="true"
          className="absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-white to-transparent"
        />
      </div>

      {/* Works-with strip */}
      <div className="border-[#ececef] border-b">
        <Container className="flex flex-col gap-5 py-9 md:flex-row md:items-center md:gap-12">
          <span className="shrink-0 font-mono text-[#9b9ca6] text-[12px] uppercase tracking-[0.08em]">
            Works with
          </span>
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-12 gap-y-6 opacity-70 grayscale">
            {(
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
                className="text-[#75768a]"
              />
            ))}
          </div>
        </Container>
      </div>
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
    <section className="relative overflow-hidden">
      <DotPatch className="top-24 right-0 hidden h-40 w-56 lg:block" />
      <Container className="pt-24 pb-28 md:pt-32">
        <Eyebrow>The problem</Eyebrow>

        <div className="mt-8 flex flex-col justify-between gap-10 lg:flex-row">
          <h2
            className={cn(
              "max-w-[560px] font-normal text-[#040406] text-[38px] leading-[1.12] tracking-[-0.02em] md:text-[56px] md:leading-[63px]",
              DISPLAY,
            )}
          >
            PostHog shows you where users drop off. Acting on it meant a second
            platform.
          </h2>

          <div className="max-w-[340px] lg:pt-2">
            <p className="text-[#2e3038] text-base leading-[24px] tracking-[-0.025em]">
              The welcome, the nudge, the win-back — Hogsend is that layer as
              code: TypeScript journeys in your repo, triggered by the events
              you already have.{" "}
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
            className="absolute -inset-x-24 -bottom-24 top-12"
            style={{
              background:
                "linear-gradient(180deg, transparent 0%, rgba(125,155,247,0.28) 45%, rgba(165,142,248,0.22) 80%, transparent 100%)",
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

/* ----------------------------------------------------------- agent cards -- */

const AGENT_CARDS = [
  {
    title: "Plain TypeScript surface",
    body: "Journeys are defineJourney() files. Claude Code, Cursor, or any agent writes and modifies them like any other code.",
    bg: "radial-gradient(130% 110% at 10% 110%, #3f68f2 0%, #8fb0ff 45%, #f4f7ff 80%)",
    corner: "#5f7ef2",
    mock: (
      <div className="rounded-md bg-[#12131a]/90 p-4 font-mono text-[11.5px] text-white/80 leading-[19px] shadow-xl">
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
    bg: "radial-gradient(130% 110% at 90% 110%, #ef5da8 0%, #f7a8cf 45%, #fef4f9 80%)",
    corner: "#ef5da8",
    mock: (
      <div className="rounded-md bg-[#12131a]/90 p-4 font-mono text-[11.5px] text-white/80 leading-[19px] shadow-xl">
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
    <section className="relative">
      <Container className="pt-8 pb-24">
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
                  className="size-2 rounded-full bg-[#6f5af6]"
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

/* ---------------------------------------------------------------- setup -- */

function PsSetup() {
  return (
    <section className="relative overflow-hidden">
      {/* Aura backdrop: warm core, blue ring. */}
      <div
        aria-hidden="true"
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(60% 55% at 50% 42%, #fdf0cf 0%, rgba(253,240,207,0.65) 28%, rgba(147,175,247,0.5) 62%, rgba(147,175,247,0.12) 85%, transparent 100%)",
        }}
      />
      <Container className="relative flex flex-col items-center pt-28 pb-32 text-center">
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
          <InlinePill>Resend</InlinePill> or <InlinePill>Postmark</InlinePill>,
          and deploys to <InlinePill>Railway</InlinePill> in one click — ten
          journeys in the scaffold, first send in minutes.
        </p>
      </Container>
    </section>
  );
}

/* -------------------------------------------------------- core platform -- */

function PsCorePlatform() {
  return (
    <section className="bg-[#060608] text-white">
      <Container className="pt-28 pb-28">
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
              First-party opens and clicks land back on the contact — and fan
              out to PostHog, Segment, or Slack, with retries and a dead-letter
              queue.
            </p>
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
    <section className="relative overflow-hidden">
      <div
        aria-hidden="true"
        className="absolute inset-y-0 left-0 w-[46%]"
        style={{
          background:
            "linear-gradient(105deg, #c9b8ff 0%, #e6ddff 55%, rgba(255,255,255,0) 100%)",
        }}
      />
      <DotPatch className="bottom-10 left-8 h-32 w-64 opacity-70" />
      <Container className="relative grid grid-cols-1 gap-14 py-28 lg:grid-cols-2">
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
      </Container>
    </section>
  );
}

/* ------------------------------------------------------ platform features -- */

const FEATURE_CARDS = [
  {
    lead: "Durable waits survive deploys.",
    rest: "A user three days into a seven-day wait keeps waiting through restarts and crashes, and resumes exactly where they were.",
    tint: "#eef2fd",
  },
  {
    lead: "In-email answers branch the journey.",
    rest: "Ask a question inside the email — the click is the answer, and the journey branches on it.",
    tint: "#f6f7fb",
  },
  {
    lead: "First-party opens and clicks.",
    rest: "Links are rewritten on send; engagement lands on your domain and fans back to PostHog as first-party events.",
    tint: "#eef2fd",
  },
  {
    lead: "Buckets are live groups of people.",
    rest: "Contacts enter and leave on behaviour — kick off journeys on either edge.",
    tint: "#f6f7fb",
  },
  {
    lead: "Events fan out, durably.",
    rest: "A fixed 13-event catalog goes back out to PostHog, Segment, Slack, or any signed webhook — with retries, backoff, and a dead-letter queue.",
    tint: "#eef2fd",
  },
  {
    lead: "Provider is config, not code.",
    rest: "EMAIL_PROVIDER=postmark swaps the wire underneath — the journey doesn't change.",
    tint: "#f6f7fb",
  },
];

function PsFeatures() {
  return (
    <section className="relative">
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

      <div className="overflow-x-auto pb-24 [scrollbar-width:none]">
        <div className="mx-auto flex w-max gap-4 px-6 md:px-[calc((100vw-1256px)/2+40px)]">
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
    <section className="relative">
      <Container className="pt-8 pb-28">
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

        <div className="mt-14 grid grid-cols-1 gap-x-8 gap-y-12 border-[#ececef] border-t pt-12 sm:grid-cols-2 lg:grid-cols-4">
          {USE_CASES.map((u) => (
            <div key={u.title}>
              <span
                aria-hidden="true"
                className="inline-flex size-8 items-center justify-center rounded-full bg-[#f1eefe] font-mono text-[#6f5af6] text-[11px]"
              >
                ▲
              </span>
              <h3 className="mt-4 font-medium text-[#040406] text-[15px] tracking-[-0.02em]">
                {u.title}
              </h3>
              <p className="mt-2 text-[#75768a] text-sm leading-[21px] tracking-[-0.02em]">
                {u.body}
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

function PsFaq() {
  return (
    <section className="relative">
      <Container className="pt-8 pb-32">
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

        <div className="mt-12">
          {FAQ.map((item) => (
            <details key={item.q} className="group border-[#ececef] border-b">
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
    <section className="relative overflow-hidden">
      <div
        aria-hidden="true"
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(115deg, #8fa8f6 0%, #7d9bf7 35%, #b9c9fb 70%, #e6ecfe 100%)",
        }}
      />
      <PixelBars
        count={72}
        className="absolute inset-x-0 bottom-0 h-[70%] justify-end"
      />
      <Container className="relative py-32">
        <h2
          className={cn(
            "max-w-[640px] font-normal text-[#0b0c12] text-[36px] leading-[1.15] tracking-[-0.02em] md:text-[48px] md:leading-[56px]",
            DISPLAY,
          )}
        >
          Ship the welcome series today, and every send after it, from your own
          repo.
        </h2>
        <div className="mt-20 flex flex-wrap items-center gap-3">
          <Btn href="/docs/getting-started" size="lg">
            Start building
          </Btn>
          <Btn
            href={RAILWAY_DEPLOY_URL}
            variant="outline"
            size="lg"
            className="border-[#121317]/40 bg-white/80 backdrop-blur"
          >
            Deploy on Railway
          </Btn>
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
      { label: "Pricing", href: "/pricing" },
      { label: "Templates", href: "/emails" },
      { label: "Integrations", href: "/integrations" },
      { label: "Changelog", href: "/changelog" },
      { label: "Studio", href: "/docs/operating/studio" },
    ],
  },
  {
    title: "Resources",
    links: [
      { label: "Docs", href: "/docs" },
      { label: "Getting started", href: "/docs/getting-started" },
      { label: "Data API", href: "/docs/data-api" },
      { label: "CLI", href: "/docs/cli" },
      { label: "llms.txt", href: "/llms.txt" },
    ],
  },
  {
    title: "Connect",
    links: [
      { label: "GitHub", href: GITHUB_URL },
      { label: "npm", href: NPM_URL },
      { label: "Discord", href: "/discord" },
      { label: "About", href: "/about" },
    ],
  },
  {
    title: "Legal",
    links: [
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
        <div className="grid grid-cols-2 gap-10 md:grid-cols-4">
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

export default function SpikePolarPage(): JSX.Element {
  return (
    <main className="tracking-normal">
      <PsNav />
      <PsHero />
      <PsProblem />
      <PsAgents />
      <PsSetup />
      <PsCorePlatform />
      <PsOpen />
      <PsFeatures />
      <PsUseCases />
      <PsFaq />
      <PsClosingCta />
      <PsFooter />
    </main>
  );
}
