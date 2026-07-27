"use client";

import { Bell, Code2, Play, Webhook } from "lucide-react";
import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ThermalHover } from "@/components/ds/thermal";
import { cn } from "@/lib/cn";
import { ENGINE_CODE } from "./system-map-code";

/* ==========================================================================
 *  The system map for the "One stream, one repo" band — a vertical scroll
 *  story that makes the claim literal.
 *
 *  Sources converge DOWN into one stream (the engine card's live ticker);
 *  the stream then runs as a BUNDLE of strands — some behind the content,
 *  some in front, for depth — through a sticky stage where the four engine
 *  moments (journeys, enrichment, conversions, buckets) swap as you scroll,
 *  each paired with a plain-language line. The bundle gathers at an outlet
 *  and fans out to the channels Hogsend actually ships.
 *
 *  Pulse dots ride measured bezier paths (SMIL animateMotion, no rAF except
 *  the one throttled scroll handler driving the sticky stage). Node chips
 *  carry hover/focus tooltips. Below lg everything stacks and the overlay
 *  hides. Under prefers-reduced-motion motion settles (home.css .ps-map).
 * ========================================================================== */

const CYCLE = 8; // seconds — one shared clock for emission dots + flashes

type MapNode = {
  label: string;
  sub: string;
  /** Plain-language tooltip shown on hover/focus. */
  tip: string;
  mark?: string; // /images/logos/<file> silhouette
  icon?: ReactNode;
};

const SOURCES: MapNode[] = [
  {
    label: "PostHog",
    sub: "product analytics",
    tip: "Events you already capture in PostHog enroll journeys directly — no export pipeline to build.",
    mark: "posthog.svg",
  },
  {
    label: "Your code",
    sub: "hogsend.capture()",
    tip: "One SDK call from your backend or browser. Anything that happens in your product can start a journey.",
    icon: <Code2 className="size-4" strokeWidth={1.5} />,
  },
  {
    label: "Segment",
    sub: "CDP forwarding",
    tip: "Point a Segment destination at Hogsend and your existing tracking plan flows straight in.",
    mark: "segment.svg",
  },
  {
    label: "Stripe",
    sub: "billing webhooks",
    tip: "Trials, payments, and failed invoices arrive as events — dunning and upgrade journeys react on their own.",
    mark: "stripe.svg",
  },
  {
    label: "Intercom & Fin",
    sub: "support events",
    tip: "Support conversations become lifecycle signals — a rough week of tickets can pause the upsell.",
    mark: "intercom.svg",
  },
  {
    label: "Video player",
    sub: "watch-depth signals",
    tip: "The Hogsend player reports how deep people actually watch — milestones fire once, scrubbing can't inflate them.",
    icon: <Play className="size-4" strokeWidth={1.5} />,
  },
  {
    label: "Webhook sources",
    sub: "any service, one transform",
    tip: "Any service that can POST a webhook becomes a source with one transform function.",
    icon: <Webhook className="size-4" strokeWidth={1.5} />,
  },
];

const CHANNELS: MapNode[] = [
  {
    label: "Email",
    sub: "Resend or Postmark",
    tip: "Sends go through your own provider account with first-party open and click tracking.",
    mark: "resend.svg",
  },
  {
    label: "SMS",
    sub: "Twilio",
    tip: "Text where email won't land — with STOP handling and consent built in.",
    mark: "twilio.svg",
  },
  {
    label: "In-app",
    sub: "feed & bell",
    tip: "A notification feed and bell inside your product, driven by the same journeys.",
    icon: <Bell className="size-4" strokeWidth={1.5} />,
  },
  {
    label: "Discord",
    sub: "DMs & channels",
    tip: "DM a member or post to a channel as a journey step — great for communities and courses.",
    mark: "discord.svg",
  },
  {
    label: "Telegram",
    sub: "bot messages",
    tip: "Your bot messages users as a journey step, same code as every other channel.",
    mark: "telegram.svg",
  },
  {
    label: "Webhooks",
    sub: "your CRM & warehouse",
    tip: "Every event and send can be forwarded, signed, to your CRM, warehouse, or anything with a URL.",
    icon: <Webhook className="size-4" strokeWidth={1.5} />,
  },
];

/* The stream itself — event shapes as they actually land. */
const STREAM_EVENTS: Array<[event: string, via: string]> = [
  ["$pageview", "posthog"],
  ["user.signup", "sdk"],
  ["checkout.completed", "stripe"],
  ["video.progress 75", "video"],
  ["support.ticket_opened", "intercom"],
  ["email.link_clicked", "tracking"],
  ["invoice.payment_failed", "stripe"],
  ["demo.booked", "segment"],
  ["contact.subscribed", "engine"],
  ["sms.link_clicked", "tracking"],
];

const SOURCE_DELAYS = [0, 1.15, 2.3, 3.45, 4.6, 5.75, 6.9];
const CHANNEL_DELAYS = [1.2, 2.5, 3.8, 5.1, 6.4, 7.7];
const CONVERGE_TRAVEL = 1.8;
const FAN_TRAVEL = 1.8;

/** Strand bundle through the engine zone: mid-bulge offsets in px, split
 *  between the back layer (behind content) and the front layer (over it). */
const BACK_STRANDS = [-150, -55, 0, 70];
const FRONT_STRANDS = [-100, 130];

/** A brand SVG painted as a flat silhouette via CSS mask (inherits color). */
function Mark({ file }: { file: string }) {
  const url = `url(/images/logos/${file})`;
  return (
    <span
      aria-hidden="true"
      className="inline-block size-4 bg-current"
      style={{
        WebkitMaskImage: url,
        maskImage: url,
        WebkitMaskRepeat: "no-repeat",
        maskRepeat: "no-repeat",
        WebkitMaskSize: "contain",
        maskSize: "contain",
        WebkitMaskPosition: "center",
        maskPosition: "center",
      }}
    />
  );
}

function NodeChip({
  node,
  side,
  flashDelay,
}: {
  node: MapNode;
  side: "source" | "channel";
  flashDelay?: number;
}) {
  return (
    <div className="group relative">
      <div
        data-map={side}
        tabIndex={0}
        className={cn(
          "flex items-center gap-2.5 rounded-lg border border-[var(--tw-border)] bg-[#120e1b]/75 px-3 py-2 outline-none backdrop-blur-md focus-visible:border-white/40",
          side === "channel" && "ps-map-arrive",
        )}
        style={
          flashDelay !== undefined
            ? { animationDelay: `${flashDelay}s` }
            : undefined
        }
      >
        <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-white/[0.05] text-white/70">
          {node.mark ? <Mark file={node.mark} /> : node.icon}
        </span>
        <span className="min-w-0">
          <span className="block truncate font-medium text-[13px] text-white tracking-[-0.02em]">
            {node.label}
          </span>
          <span className="block truncate text-[11px] text-white/45 tracking-[-0.01em]">
            {node.sub}
          </span>
        </span>
      </div>
      {/* Tooltip — plain language, above the chip. */}
      <div
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-30 mb-2 w-[240px] -translate-x-1/2 rounded-lg border border-white/15 bg-[#0a0606] px-3 py-2.5 text-left opacity-0 shadow-lg transition-opacity duration-200 group-focus-within:opacity-100 group-hover:opacity-100"
      >
        <p className="text-[12px] text-white/75 leading-[18px] tracking-[-0.01em]">
          {node.tip}
        </p>
      </div>
    </div>
  );
}

/* --------------------------------------------------------- stream head -- */

/** The crimzon-triangle window title mark from the hero/closing-CTA chrome. */
function TitleMark() {
  return (
    <svg
      width="9"
      height="8"
      viewBox="0 0 9 8"
      aria-hidden="true"
      className="shrink-0 text-[#f64838]"
    >
      <path d="M4.5 0L9 8H0z" fill="currentColor" />
    </svg>
  );
}

function StreamCard() {
  return (
    <ThermalHover rounded="rounded-xl" className="mx-auto w-full max-w-[460px]">
      <div
        data-map="stream"
        className="relative overflow-hidden rounded-xl border border-white/15 bg-[#0a0606] shadow-lg"
      >
        <div className="flex items-center justify-between border-white/10 border-b px-4 py-2.5">
          <span className="inline-flex items-center gap-2 font-mono text-[11px] text-white/40 uppercase tracking-[0.08em]">
            <TitleMark />
            hogsend engine — one event stream
          </span>
          <span className="flex items-center gap-2 font-mono text-[10px] text-white/40 uppercase tracking-[0.08em]">
            <span className="ps-pulse size-1.5 rounded-full bg-[#f64838]" />
            in your repo
          </span>
        </div>
        <div
          className="relative h-[118px] overflow-hidden px-4"
          style={{
            maskImage:
              "linear-gradient(180deg, transparent 0%, black 22%, black 78%, transparent 100%)",
            WebkitMaskImage:
              "linear-gradient(180deg, transparent 0%, black 22%, black 78%, transparent 100%)",
          }}
        >
          <div className="ps-map-ticker py-2">
            {[...STREAM_EVENTS, ...STREAM_EVENTS].map(([event, via], i) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: static doubled list
                key={i}
                className="flex items-center justify-between gap-3 py-[3px] font-mono text-[11px]"
              >
                <span className="truncate text-white/80">{event}</span>
                <span className="shrink-0 text-white/35">via {via}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </ThermalHover>
  );
}

/* -------------------------------------------------------- engine panels -- */

function PanelCard({
  caption,
  children,
}: {
  caption: string;
  children: ReactNode;
}) {
  return (
    <ThermalHover rounded="rounded-xl">
      <div className="overflow-hidden rounded-xl border border-white/15 bg-[#0a0606] shadow-lg">
        <div className="flex items-center gap-2 border-white/10 border-b px-4 py-2.5">
          <TitleMark />
          <span className="font-mono text-[11px] text-white/40 tracking-[-0.01em]">
            {caption}
          </span>
        </div>
        <div className="px-4 py-4">{children}</div>
      </div>
    </ThermalHover>
  );
}

/** A durable journey run — the trace idiom, steps lighting in sequence. */
function JourneysVisual() {
  const steps = [
    { kind: "trigger", label: "user.signed_up", note: "trigger" },
    { kind: "send", label: "welcome", note: "sendEmail" },
    {
      kind: "wait",
      label: "project.created — 3d timeout",
      note: "ctx.waitForEvent · survives deploys",
    },
    {
      kind: "branch",
      label: "timedOut ? activation-nudge : first-win",
      note: "branch on the answer",
    },
  ];
  return (
    <PanelCard caption="src/journeys/onboarding.ts — a durable run">
      <div className="flex flex-col">
        {steps.map((s, i) => (
          <div
            key={s.label}
            className="ps-map-step flex gap-3.5"
            style={{ animationDelay: `${i * (CYCLE / steps.length)}s` }}
          >
            <div className="flex flex-col items-center">
              <span
                className={cn(
                  "mt-1 inline-flex size-2.5 shrink-0 rounded-full",
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
            <div className={i < steps.length - 1 ? "pb-4" : ""}>
              <p className="font-mono text-[12.5px] text-white">{s.label}</p>
              <p className="mt-0.5 font-mono text-[11px] text-white/40">
                {s.note}
              </p>
            </div>
          </div>
        ))}
      </div>
    </PanelCard>
  );
}

/** Apollo enrichment — empty contact fields filling in, fill-if-absent. */
function EnrichmentVisual() {
  const fields: Array<[label: string, value: string]> = [
    ["company", "Acme Inc"],
    ["role", "Head of Growth"],
    ["company size", "51–200"],
  ];
  return (
    <PanelCard caption="contact — jamie@acme.dev">
      <div className="flex flex-col gap-2.5">
        {fields.map(([label, value], i) => (
          <div
            key={label}
            className="flex items-center justify-between gap-3 font-mono text-[12px]"
          >
            <span className="text-white/45">{label}</span>
            <span className="relative text-right">
              <span
                className="ps-map-fill-out text-white/25"
                style={{ animationDelay: `${i * 1.4 - 14}s` }}
              >
                —
              </span>
              <span
                className="ps-map-fill absolute inset-y-0 right-0 flex items-center gap-2 whitespace-nowrap"
                style={{ animationDelay: `${i * 1.4 - 14}s` }}
              >
                <span className="rounded-full bg-[#f64838]/[0.1] px-2 py-0.5 text-[10px] text-[#f64838]">
                  via apollo
                </span>
                <span className="text-white/85">{value}</span>
              </span>
            </span>
          </div>
        ))}
      </div>
      <p className="mt-4 border-[var(--tw-border)] border-t pt-3 font-mono text-[11px] text-white/40">
        fill-if-absent — your own data always wins
      </p>
    </PanelCard>
  );
}

/** Conversion & attribution readout — arms vs holdout, credit scoped. */
function ConversionsVisual() {
  const rows: Array<[label: string, pct: number, tone: string]> = [
    ["subject-a", 4.1, "bg-white/35"],
    ["subject-b", 5.6, "bg-[#f64838]"],
    ["holdout", 2.3, "bg-white/15"],
  ];
  const max = 6;
  return (
    <PanelCard caption="trial-conversion — 30d click window">
      <div className="flex flex-col gap-3">
        {rows.map(([label, pct, tone], i) => (
          <div key={label} className="font-mono text-[12px]">
            <div className="flex items-center justify-between gap-3">
              <span className="text-white/60">{label}</span>
              <span className="text-white/85">{pct}%</span>
            </div>
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/[0.06]">
              <div
                className={cn("ps-map-grow h-full rounded-full", tone)}
                style={{
                  width: `${(pct / max) * 100}%`,
                  animationDelay: `${0.2 + i * 0.15}s`,
                }}
              />
            </div>
          </div>
        ))}
      </div>
      <p className="mt-4 border-[var(--tw-border)] border-t pt-3 font-mono text-[11px] text-white/40">
        credit scoped to the journey · lift vs holdout +3.3pp
      </p>
    </PanelCard>
  );
}

/** The buckets board — lifecycle lanes, a contact moving between them. */
function BucketsVisual() {
  const lanes: Array<{ name: string; cards: string[] }> = [
    { name: "trial", cards: ["sam@", "lee@"] },
    { name: "active", cards: ["kai@"] },
    { name: "dormant", cards: ["mia@"] },
  ];
  return (
    <PanelCard caption="src/buckets/went-dormant.ts">
      <div className="grid grid-cols-3 gap-2">
        {lanes.map((lane, li) => (
          <div
            key={lane.name}
            className="rounded-lg border border-[var(--tw-border)] bg-white/[0.02] p-2"
          >
            <p className="mb-2 font-mono text-[10px] text-white/40 uppercase tracking-[0.08em]">
              {lane.name}
            </p>
            <div className="flex flex-col gap-1.5">
              {lane.cards.map((c) => (
                <div
                  key={c}
                  className="rounded-md border border-[var(--tw-border)] bg-white/[0.04] px-2 py-1.5 font-mono text-[11px] text-white/70"
                >
                  {c}
                </div>
              ))}
              {/* jo@ drifts: leaves `active`, lands in `dormant`. */}
              {li === 1 && (
                <div className="ps-map-card-out rounded-md border border-[var(--tw-border)] bg-white/[0.04] px-2 py-1.5 font-mono text-[11px] text-white/70">
                  jo@
                </div>
              )}
              {li === 2 && (
                <div className="ps-map-card-in rounded-md border border-[#f6483855] bg-[#f64838]/[0.06] px-2 py-1.5 font-mono text-[11px] text-white/85">
                  jo@
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      <p className="mt-4 border-[var(--tw-border)] border-t pt-3 font-mono text-[11px] text-white/40">
        entering dormant triggers the win-back journey
      </p>
    </PanelCard>
  );
}

/* ---------------------------------------------------- sticky engine stage -- */

const ENGINE_STEPS = [
  {
    key: "journeys",
    eyebrow: "Journeys",
    title: "Follow up like a person would",
    body: "Someone signs up, goes quiet, or hits a limit — a journey picks them up, waits days if it has to, and carries on exactly where it left off through any deploy.",
    visual: <JourneysVisual />,
  },
  {
    key: "enrichment",
    eyebrow: "Enrichment",
    title: "Know who just showed up",
    body: "Apollo fills in company, role, and size the moment a contact appears — but only where your own data has gaps. Nothing you know gets overwritten.",
    visual: <EnrichmentVisual />,
  },
  {
    key: "conversions",
    eyebrow: "Conversions",
    title: "Proof, not vibes",
    body: "Split the message inside the journey, exit anyone who converts, and read every arm against a holdout that never got the message.",
    visual: <ConversionsVisual />,
  },
  {
    key: "buckets",
    eyebrow: "Buckets",
    title: "Lanes that move themselves",
    body: "Contacts sort into lifecycle lanes as they behave. Falling into dormant is itself a trigger — the win-back journey starts on its own.",
    visual: <BucketsVisual />,
  },
];

/** Desktop: a sticky stage where the four engine moments play inside ONE
 *  persistent IDE window — the chrome, tab rail, and preview slot never
 *  move, only the open file and its live preview swap. That persistence is
 *  what keeps the step change calm. One direct scroll listener picks the
 *  active step (a rect read + an index compare — React no-ops unchanged
 *  setState); the swap itself is a CSS transition (no per-frame styling,
 *  no persistent layers — the StackDeck law). Tabs are clickable and jump
 *  the scroll to that step's slice of the zone. */
function StickyEngineStage({ code }: { code?: ReactNode[] }) {
  const zoneRef = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState(0);

  useEffect(() => {
    const zone = zoneRef.current;
    if (!zone) return;
    const update = () => {
      const rect = zone.getBoundingClientRect();
      const span = rect.height - window.innerHeight;
      if (span <= 0) return;
      const progress = Math.min(1, Math.max(0, -rect.top / span));
      setStep(
        Math.min(
          ENGINE_STEPS.length - 1,
          Math.floor(progress * ENGINE_STEPS.length),
        ),
      );
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  const jumpTo = (i: number) => {
    const zone = zoneRef.current;
    if (!zone) return;
    const top = zone.getBoundingClientRect().top + window.scrollY;
    const span = zone.offsetHeight - window.innerHeight;
    window.scrollTo({
      top: top + (span * (i + 0.5)) / ENGINE_STEPS.length,
      behavior: "smooth",
    });
  };

  return (
    <div
      ref={zoneRef}
      className="relative hidden lg:block"
      style={{ height: `${ENGINE_STEPS.length * 120}vh` }}
    >
      <div className="sticky top-0 flex h-screen items-center">
        <div className="grid w-full grid-cols-[minmax(280px,340px)_1fr] items-center gap-x-14 xl:gap-x-20">
          {/* Copy column — the plain-language read on the active step. */}
          <div className="relative z-30">
            <div className="relative w-full">
              {ENGINE_STEPS.map((s, i) => (
                <div
                  key={s.key}
                  className={cn(
                    "transition-all duration-500",
                    i === step
                      ? "translate-y-0 opacity-100"
                      : "pointer-events-none absolute inset-0 translate-y-3 opacity-0",
                  )}
                  aria-hidden={i !== step}
                >
                  <p className="font-mono text-[10px] text-white/40 uppercase tracking-[0.08em]">
                    {s.eyebrow}
                  </p>
                  <h3 className="mt-3 font-medium text-[24px] text-white leading-[30px] tracking-[-0.02em]">
                    {s.title}
                  </h3>
                  <p className="mt-3 text-[15px] text-white/60 leading-[23px] tracking-[-0.02em]">
                    {s.body}
                  </p>
                </div>
              ))}
              {/* Step markers double as navigation. */}
              <div className="mt-8 flex items-center gap-2">
                {ENGINE_STEPS.map((s, i) => (
                  <button
                    key={s.key}
                    type="button"
                    aria-label={`Go to ${s.eyebrow}`}
                    onClick={() => jumpTo(i)}
                    className={cn(
                      "h-1 rounded-full transition-all duration-500",
                      i === step
                        ? "w-6 bg-[#f64838]"
                        : "w-2.5 bg-white/15 hover:bg-white/30",
                    )}
                  />
                ))}
              </div>
            </div>
          </div>

          {/* The persistent IDE window: tab rail + code pane + floating
              live preview. Only the pane contents swap. */}
          <div className="relative z-30 w-full max-w-[720px]">
            <ThermalHover rounded="rounded-xl">
              <div className="overflow-hidden rounded-xl border border-white/15 bg-[#0a0606] shadow-lg">
                {/* Title bar — matches the hero agent-session window. */}
                <div className="flex items-center gap-3 border-white/10 border-b px-4 py-2.5">
                  <div aria-hidden="true" className="flex items-center gap-1.5">
                    <span className="size-2.5 rounded-full bg-white/15" />
                    <span className="size-2.5 rounded-full bg-white/15" />
                    <span className="size-2.5 rounded-full bg-white/15" />
                  </div>
                  <span className="font-mono text-[11px] text-white/40 tracking-wide">
                    hogsend — your repo
                  </span>
                </div>
                {/* File tabs — the four engine moments ARE files. */}
                <div className="flex items-center gap-1 overflow-x-auto border-white/10 border-b px-2 pt-1.5">
                  {ENGINE_CODE.map((f, i) => (
                    <button
                      key={f.key}
                      type="button"
                      onClick={() => jumpTo(i)}
                      className={cn(
                        "relative shrink-0 rounded-t-md px-3 py-2 font-mono text-[11px] transition-colors duration-300",
                        i === step
                          ? "bg-white/[0.05] text-white"
                          : "text-white/40 hover:text-white/70",
                      )}
                    >
                      <span className="flex items-center gap-1.5">
                        {i === step && <TitleMark />}
                        {f.file}
                      </span>
                      <span
                        className={cn(
                          "absolute inset-x-0 bottom-0 h-px transition-opacity duration-300",
                          i === step ? "bg-[#f64838] opacity-100" : "opacity-0",
                        )}
                      />
                    </button>
                  ))}
                </div>
                {/* Editor body: code pane with the live preview floating
                    bottom-right, scaffold-explorer style. */}
                <div className="relative h-[470px]">
                  {ENGINE_STEPS.map((s, i) => (
                    <div
                      key={s.key}
                      className={cn(
                        "absolute inset-0 transition-opacity duration-500",
                        i === step
                          ? "opacity-100"
                          : "pointer-events-none opacity-0",
                      )}
                      aria-hidden={i !== step}
                    >
                      <div
                        className="h-full overflow-hidden px-4 py-3 text-[12.5px]"
                        style={{
                          maskImage:
                            "linear-gradient(180deg, black 82%, transparent 100%)",
                          WebkitMaskImage:
                            "linear-gradient(180deg, black 82%, transparent 100%)",
                        }}
                      >
                        {code?.[i] ?? null}
                      </div>
                      <div className="absolute right-4 bottom-4 w-[320px]">
                        {s.visual}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </ThermalHover>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------- measured overlay -- */

type Geometry = {
  w: number;
  h: number;
  converge: string[];
  back: string[];
  front: string[];
  fan: string[];
};

function vBezier(a: { x: number; y: number }, b: { x: number; y: number }) {
  const dy = b.y - a.y;
  const r = (n: number) => Math.round(n * 10) / 10;
  return `M ${r(a.x)} ${r(a.y)} C ${r(a.x)} ${r(a.y + dy * 0.45)}, ${r(b.x)} ${r(
    b.y - dy * 0.45,
  )}, ${r(b.x)} ${r(b.y)}`;
}

/** Long strand from a to b bulging `mid` px sideways through the middle. */
function strand(
  a: { x: number; y: number },
  b: { x: number; y: number },
  mid: number,
) {
  const r = (n: number) => Math.round(n * 10) / 10;
  const third = (b.y - a.y) / 3;
  return `M ${r(a.x)} ${r(a.y)} C ${r(a.x + mid)} ${r(a.y + third)}, ${r(
    b.x + mid,
  )} ${r(b.y - third)}, ${r(b.x)} ${r(b.y)}`;
}

function useMapGeometry(ref: React.RefObject<HTMLDivElement | null>) {
  const [geom, setGeom] = useState<Geometry | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const measure = () => {
      if (window.innerWidth < 1024) {
        setGeom(null);
        return;
      }
      const box = el.getBoundingClientRect();
      if (box.width === 0) return;
      const stream = el.querySelector('[data-map="stream"]');
      const outlet = el.querySelector('[data-map="outlet"]');
      if (!stream || !outlet) return;
      const rel = (x: number, y: number) => ({
        x: x - box.left,
        y: y - box.top,
      });

      const sr = stream.getBoundingClientRect();
      const or = outlet.getBoundingClientRect();
      const inlet = rel(sr.left + sr.width / 2, sr.top);
      const bundleTop = rel(sr.left + sr.width / 2, sr.bottom);
      const bundleEnd = rel(or.left + or.width / 2, or.top + or.height / 2);

      const sources = el.querySelectorAll('[data-map="source"]');
      const channels = el.querySelectorAll('[data-map="channel"]');

      setGeom({
        w: box.width,
        h: box.height,
        converge: [...sources].map((s, i) => {
          const r = s.getBoundingClientRect();
          return vBezier(rel(r.left + r.width / 2, r.bottom), {
            x: inlet.x + (i - (sources.length - 1) / 2) * 7,
            y: inlet.y,
          });
        }),
        back: BACK_STRANDS.map((mid) => strand(bundleTop, bundleEnd, mid)),
        front: FRONT_STRANDS.map((mid) => strand(bundleTop, bundleEnd, mid)),
        fan: [...channels].map((c) => {
          const r = c.getBoundingClientRect();
          return vBezier(bundleEnd, rel(r.left + r.width / 2, r.top));
        }),
      });
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);

  return geom;
}

function TravelDot({
  path,
  begin,
  travel,
}: {
  path: string;
  begin: number;
  travel: number;
}) {
  return (
    <g className="ps-map-dot" style={{ animationDelay: `${begin}s` }}>
      <circle r={2.5} fill="#f64838">
        <animateMotion
          dur={`${CYCLE}s`}
          begin={`${begin}s`}
          repeatCount="indefinite"
          calcMode="linear"
          keyPoints="0;1;1"
          keyTimes={`0;${travel / CYCLE};1`}
          path={path}
        />
      </circle>
    </g>
  );
}

/** A dot that rides a strand continuously — no blink window needed. */
function StrandDot({
  path,
  dur,
  begin,
  r = 2.5,
}: {
  path: string;
  dur: number;
  begin: number;
  r?: number;
}) {
  return (
    <g className="ps-map-dot-solid">
      <circle r={r} fill="#f64838">
        <animateMotion
          dur={`${dur}s`}
          begin={`${begin}s`}
          repeatCount="indefinite"
          calcMode="linear"
          path={path}
        />
      </circle>
    </g>
  );
}

function OverlaySvg({
  geom,
  paths,
  dots,
  className,
  strokeOpacity,
}: {
  geom: Geometry;
  paths: string[];
  dots: ReactNode;
  className?: string;
  strokeOpacity: number;
}) {
  return (
    <svg
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-0 hidden lg:block",
        className,
      )}
      width={geom.w}
      height={geom.h}
      viewBox={`0 0 ${geom.w} ${geom.h}`}
      fill="none"
    >
      {paths.map((d, i) => (
        <path
          // biome-ignore lint/suspicious/noArrayIndexKey: positional geometry
          key={i}
          d={d}
          pathLength={1}
          className="ps-map-path"
          stroke={`rgba(255,255,255,${strokeOpacity})`}
          strokeWidth={1}
          style={{ animationDelay: `${i * 0.05}s` }}
        />
      ))}
      {dots}
    </svg>
  );
}

/* ------------------------------------------------------------- component -- */

export function SystemMap({
  className,
  code,
}: {
  className?: string;
  /** Server-highlighted code panes, index-matched to ENGINE_STEPS /
   *  ENGINE_CODE (rendered by the page with CodeHighlight). */
  code?: ReactNode[];
}) {
  const mapRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);

  // Start the clock only once the map is actually on screen.
  useEffect(() => {
    const el = mapRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setActive(true);
          io.disconnect();
        }
      },
      { rootMargin: "0px 0px -15% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const geom = useMapGeometry(mapRef);

  return (
    <div
      ref={mapRef}
      className={cn("ps-map relative", active && "is-active", className)}
    >
      {/* Depth layer BEHIND the content: converge, back strands, fan. */}
      {geom ? (
        <OverlaySvg
          geom={geom}
          className="z-0"
          strokeOpacity={0.16}
          paths={[...geom.converge, ...geom.back, ...geom.fan]}
          dots={
            active ? (
              <g className="ps-map-dots">
                {geom.converge.map((d, i) => (
                  <TravelDot
                    // biome-ignore lint/suspicious/noArrayIndexKey: positional geometry
                    key={`c${i}`}
                    path={d}
                    begin={SOURCE_DELAYS[i] ?? 0}
                    travel={CONVERGE_TRAVEL}
                  />
                ))}
                {geom.back.map((d, i) => (
                  <StrandDot
                    // biome-ignore lint/suspicious/noArrayIndexKey: positional geometry
                    key={`b${i}`}
                    path={d}
                    dur={5.5 + i * 0.9}
                    begin={-i * 2.1}
                    r={2}
                  />
                ))}
                {geom.fan.map((d, i) => (
                  <TravelDot
                    // biome-ignore lint/suspicious/noArrayIndexKey: positional geometry
                    key={`f${i}`}
                    path={d}
                    begin={CHANNEL_DELAYS[i] ?? 0}
                    travel={FAN_TRAVEL}
                  />
                ))}
              </g>
            ) : null
          }
        />
      ) : null}

      {/* ------------------------------------------------ sources, in -- */}
      <div className="relative z-10">
        <p className="mb-4 text-center font-mono text-[10px] text-white/40 uppercase tracking-[0.08em]">
          Everything in
        </p>
        <div className="mx-auto flex max-w-[900px] flex-wrap justify-center gap-2.5">
          {SOURCES.map((node) => (
            <NodeChip key={node.label} node={node} side="source" />
          ))}
        </div>
      </div>

      <MobileSpine />
      <div aria-hidden="true" className="hidden h-24 lg:block" />

      {/* ------------------------------------------------- the stream -- */}
      {/* z-30: the hero cards sit ABOVE even the front depth strands —
          lines may cross the map, never the main windows. */}
      <div className="relative z-30">
        <StreamCard />
      </div>

      <MobileSpine />

      {/* ---------------------------------------------- engine moments -- */}
      <StickyEngineStage code={code} />
      {/* Mobile: the same four moments stacked — copy, code, live visual. */}
      <div className="flex flex-col gap-14 lg:hidden">
        {ENGINE_STEPS.map((s, i) => (
          <div key={s.key}>
            <p className="font-mono text-[10px] text-white/40 uppercase tracking-[0.08em]">
              {s.eyebrow}
            </p>
            <h3 className="mt-2 font-medium text-[19px] text-white leading-[25px] tracking-[-0.02em]">
              {s.title}
            </h3>
            <p className="mt-2 mb-5 text-[14px] text-white/60 leading-[21px] tracking-[-0.02em]">
              {s.body}
            </p>
            {code?.[i] ? (
              <div className="mb-4 overflow-hidden rounded-xl border border-white/15 bg-[#0a0606]">
                <div className="flex items-center gap-2 border-white/10 border-b px-4 py-2.5">
                  <TitleMark />
                  <span className="font-mono text-[11px] text-white/40">
                    {ENGINE_CODE[i]?.file}
                  </span>
                </div>
                <div className="overflow-x-auto px-4 py-3 text-[12px]">
                  {code[i]}
                </div>
              </div>
            ) : null}
            {s.visual}
          </div>
        ))}
      </div>

      <MobileSpine />
      <div aria-hidden="true" className="hidden h-16 lg:block" />

      {/* Also reading the stream — the rest of the engine, named. */}
      <p className="relative z-10 text-center font-mono text-[11px] text-white/40 tracking-[-0.01em]">
        also reading the stream: groups · flags · broadcasts
      </p>

      <div className="relative z-10 mt-6 flex justify-center">
        <span
          data-map="outlet"
          className="ps-pulse inline-flex size-2 rounded-full bg-[#f64838]"
        />
      </div>

      <MobileSpine />
      <div aria-hidden="true" className="hidden h-24 lg:block" />

      {/* ------------------------------------------------ channels, out -- */}
      <div className="relative z-10">
        <p className="mb-4 text-center font-mono text-[10px] text-white/40 uppercase tracking-[0.08em]">
          Reach them where they are
        </p>
        <div className="mx-auto flex max-w-[900px] flex-wrap justify-center gap-2.5">
          {CHANNELS.map((node, i) => (
            <NodeChip
              key={node.label}
              node={node}
              side="channel"
              flashDelay={CHANNEL_DELAYS[i] + FAN_TRAVEL - 0.2}
            />
          ))}
        </div>
      </div>

      {/* Depth layer IN FRONT of the content: two faint strands passing
          over the stage — kept quiet so copy stays readable. */}
      {geom ? (
        <OverlaySvg
          geom={geom}
          className="z-20"
          strokeOpacity={0.07}
          paths={geom.front}
          dots={
            active ? (
              <g className="ps-map-dots">
                {geom.front.map((d, i) => (
                  <StrandDot
                    // biome-ignore lint/suspicious/noArrayIndexKey: positional geometry
                    key={`fs${i}`}
                    path={d}
                    dur={7 + i * 1.3}
                    begin={-i * 3.4}
                    r={1.8}
                  />
                ))}
              </g>
            ) : null
          }
        />
      ) : null}
    </div>
  );
}

function MobileSpine() {
  return (
    <div className="flex justify-center py-2 lg:hidden">
      <svg
        aria-hidden="true"
        width="2"
        height="44"
        viewBox="0 0 2 44"
        className="overflow-visible"
      >
        <path
          d="M1 0 V44"
          className="ps-dash"
          stroke="rgba(255,255,255,0.25)"
          strokeWidth="1.5"
        />
      </svg>
    </div>
  );
}
