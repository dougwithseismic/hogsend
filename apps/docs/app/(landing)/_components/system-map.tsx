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
 *  The system map for the "One stream, one repo" band — one continuous
 *  diagram that makes the claim literal. It does NOT hijack the scroll:
 *  the page scrolls normally and the diagram animates on its own clock.
 *
 *  Sources converge DOWN into one stream (the engine card's live ticker);
 *  the stream then runs as a BUNDLE of strands — some behind the content,
 *  some in front, for depth — through the engine band, where the four
 *  moments (journeys, enrichment, conversions, buckets) all read at once and
 *  the open one shows its real file. The bundle gathers at an outlet
 *  and fans out to the channels Hogsend actually ships.
 *
 *  Pulse dots ride measured bezier paths (SMIL animateMotion, no rAF except
 *  no scroll handlers at all). Node chips carry hover/focus tooltips. Below
 *  lg everything stacks and the overlay hides. Under prefers-reduced-motion
 *  motion settles and the band stops advancing (home.css .ps-map).
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
    sub: "one transform",
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
    sub: "CRM & warehouse",
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
    // flex-1 — every node keeps ONE rail. Stacked (not side-by-side) so
    // seven sources fit a single row: a second row would sit on top of the
    // first row's converge lines and read as unconnected.
    <div className="group relative min-w-0 flex-1">
      {/* A button, not a div: the tooltip is the affordance, so the chip has
          to be reachable by keyboard as well as hover. Every surface in the
          map wears the same cursor edge-glow — it was the tell that some
          cards were "real" and others weren't. */}
      <ThermalHover rounded="rounded-lg">
        <button
          type="button"
          data-map={side}
          className={cn(
            "flex w-full cursor-default flex-col gap-2 rounded-lg border border-[var(--tw-border)] bg-[#0d0d11]/80 px-3 py-2.5 text-left outline-none backdrop-blur-md focus-visible:border-white/40",
            side === "channel" && "ps-map-arrive",
          )}
          style={
            flashDelay !== undefined
              ? { animationDelay: `${flashDelay}s` }
              : undefined
          }
        >
          <span className="inline-flex size-7 items-center justify-center rounded-md bg-white/[0.05] text-white/70">
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
        </button>
      </ThermalHover>
      {/* Tooltip — plain language, above the chip. */}
      <div
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-30 mb-2 w-[240px] -translate-x-1/2 rounded-lg border border-white/15 bg-[#0d0d11] px-3 py-2.5 text-left opacity-0 shadow-lg transition-opacity duration-200 group-focus-within:opacity-100 group-hover:opacity-100"
      >
        <p className="text-[12px] text-white/75 leading-[18px] tracking-[-0.01em]">
          {node.tip}
        </p>
      </div>
    </div>
  );
}

/* --------------------------------------------------------- stream head -- */

/** The window title mark — the Hogsend boar, not a generic triangle. */
function TitleMark() {
  const url = "url(/images/logos/hogsend-boar.svg)";
  return (
    <span
      aria-hidden="true"
      className="inline-block h-[9px] w-[16px] shrink-0 bg-[#f64838]"
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

function StreamCard() {
  return (
    <ThermalHover rounded="rounded-xl" className="mx-auto w-full max-w-[460px]">
      <div
        data-map="stream"
        className="relative overflow-hidden rounded-xl border border-white/[0.09] bg-[#0d0d11] shadow-2xl"
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
      <div className="overflow-hidden rounded-xl border border-white/[0.09] bg-[#0d0d11] shadow-2xl">
        <div className="flex items-center gap-2 border-white/[0.07] border-b px-4 py-3">
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
    <PanelCard caption="a durable run — survives deploys">
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
      <div className="mt-4 flex flex-col gap-1.5 border-[var(--tw-border)] border-t pt-3 font-mono text-[11.5px]">
        <div className="flex items-center justify-between gap-3">
          <span className="text-white/45">group</span>
          <span className="text-white/85">
            company: acme.dev
            <span className="text-white/40"> · 4 contacts</span>
          </span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-white/45">bucket</span>
          <span className="text-white/85">
            high-fit
            <span className="text-white/40"> → welcome journey</span>
          </span>
        </div>
      </div>
      <p className="mt-3 border-[var(--tw-border)] border-t pt-3 font-mono text-[11px] text-white/40">
        fill-if-absent — your own data always wins
      </p>
    </PanelCard>
  );
}

/** The Studio Impact readout — the demo instance's real numbers: causal
 *  lift vs the built-in holdout, then fractional revenue credit per
 *  template (demo.hogsend.com, welcome journey, 90d). */
function ConversionsVisual() {
  const cohorts: Array<
    [label: string, detail: string, pct: number, tone: string]
  > = [
    ["entered (85%)", "660 contacts", 46.8, "bg-[#f64838]"],
    ["held out (15%)", "95 contacts", 22.1, "bg-white/25"],
  ];
  const revenue: Array<[template: string, value: string]> = [
    ["activation-nudge", "$12,370"],
    ["activation-connect-repo", "$11,357"],
    ["welcome", "$7,899"],
  ];
  return (
    <PanelCard caption="impact — goal: credits-purchased · 90d">
      <p className="font-mono text-[12px]">
        <span className="rounded bg-[#f64838]/[0.12] px-1.5 py-0.5 text-[#f64838]">
          causal +111.8%
        </span>{" "}
        <span className="text-white/60">· 100% win probability</span>
      </p>
      <div className="mt-3 flex flex-col gap-2.5">
        {cohorts.map(([label, detail, pct, tone], i) => (
          <div key={label} className="font-mono text-[11.5px]">
            <div className="flex items-center justify-between gap-3">
              <span className="text-white/60">{label}</span>
              <span className="text-white/85">
                <span className="text-white/40">{detail} · </span>
                {pct}%
              </span>
            </div>
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-white/[0.06]">
              <div
                className={cn("ps-map-grow h-full rounded-full", tone)}
                style={{
                  width: `${(pct / 50) * 100}%`,
                  animationDelay: `${0.2 + i * 0.15}s`,
                }}
              />
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3.5 border-[var(--tw-border)] border-t pt-3">
        <p className="mb-2 font-mono text-[10px] text-white/40 uppercase tracking-[0.08em]">
          Attributed revenue · blended, fractional
        </p>
        {revenue.map(([template, value]) => (
          <div
            key={template}
            className="flex items-center justify-between gap-3 py-[2px] font-mono text-[11.5px]"
          >
            <span className="truncate text-white/60">{template}</span>
            <span className="shrink-0 text-white/85">{value}</span>
          </div>
        ))}
      </div>
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

/** The Studio deals board — the pipeline every touch feeds, stage lanes
 *  with fractional-credit values (illustrative deals, real product shape). */
function DealsVisual() {
  const lanes: Array<{ name: string; cards: Array<[string, string]> }> = [
    {
      name: "qualified",
      cards: [
        ["Acme", "$4.2k"],
        ["Kite", "$1.8k"],
      ],
    },
    { name: "proposal", cards: [["Nova", "$6.5k"]] },
    { name: "won", cards: [["Rove", "$3.1k"]] },
  ];
  return (
    <PanelCard caption="studio — deals">
      <div className="grid grid-cols-3 gap-2">
        {lanes.map((lane) => (
          <div
            key={lane.name}
            className="rounded-lg border border-[var(--tw-border)] bg-white/[0.02] p-2"
          >
            <p className="mb-2 font-mono text-[10px] text-white/40 uppercase tracking-[0.08em]">
              {lane.name}
            </p>
            <div className="flex flex-col gap-1.5">
              {lane.cards.map(([name, value]) => (
                <div
                  key={name}
                  className={cn(
                    "rounded-md border px-2 py-1.5 font-mono text-[11px]",
                    lane.name === "won"
                      ? "border-[#f6483855] bg-[#f64838]/[0.06] text-white/85"
                      : "border-[var(--tw-border)] bg-white/[0.04] text-white/70",
                  )}
                >
                  {name}
                  <span className="float-right text-white/45">{value}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <p className="mt-4 border-[var(--tw-border)] border-t pt-3 font-mono text-[11px] text-white/40">
        every email, SMS, and DM on the deal's timeline
      </p>
    </PanelCard>
  );
}

/* ---------------------------------------------------- sticky engine stage -- */

/* The four cards ARE the four pillars — Measure, React, Prove, Steer.
 * Each opens a folder of real files; the features (journeys, enrichment,
 * conversions, buckets, broadcasts, flags) live INSIDE the pillars. */
const ENGINE_STEPS = [
  {
    key: "measure",
    eyebrow: "Measure",
    title: "Know who just showed up",
    body: "A signup lands and the picture fills in on its own: who they are, the company behind them, and which lane they're in — trial, active, gone quiet.",
    visual: <EnrichmentVisual />,
  },
  {
    key: "react",
    eyebrow: "React",
    title: "Follow up like a person would",
    body: "Someone signs up, goes quiet, or hits a limit — a journey picks them up, waits days if it has to, and carries on exactly where it left off through any deploy.",
    visual: <JourneysVisual />,
  },
  {
    key: "prove",
    eyebrow: "Prove",
    title: "Proof, not vibes",
    body: "Answers the question other tools dodge: did the emails actually make money? Some people are held out, everyone else is read against them, and revenue is credited touch by touch.",
    visual: <ConversionsVisual />,
  },
  {
    key: "steer",
    eyebrow: "Steer",
    title: "Drive it from one screen",
    body: "Studio is mission control: every journey run, every send, every deal in the pipeline. Send a broadcast, flip a flag, and see what each touch was worth.",
    visual: <DealsVisual />,
  },
];

/** Files whose story outgrows their pillar's default preview — the bucket
 *  files keep the lanes board wherever they appear. */
const FILE_VISUALS: Record<string, ReactNode> = {
  "went-dormant": <BucketsVisual />,
  "bucket-winback": <BucketsVisual />,
};

/** How long each moment holds before the band advances itself (ms). */
const STEP_DWELL = 6000;

/** ENGINE_CODE grouped per moment, each file keeping its flat index into
 *  the server-highlighted `code` panes (index-matched to ENGINE_CODE). */
const FILES_BY_STEP = ENGINE_STEPS.map((s) =>
  ENGINE_CODE.map((f, flat) => ({ ...f, flat })).filter(
    (f) => f.step === s.key,
  ),
);

/** The engine band — a STATION in the diagram, not a scroll stage.
 *
 *  All four moments stay readable at once as selector cards, so the whole
 *  engine reads at a glance; the IDE window below opens the active moment's
 *  real file with its live preview docked alongside. It advances on its own
 *  clock while the map is in view and pins to whatever you click, so nothing
 *  here hijacks the scroll — the diagram is the diagram, and the page
 *  scrolls the way every other page does.
 *
 *  Only the open file and its preview swap; the chrome never moves. The swap
 *  is a CSS transition (no per-frame styling, no persistent compositor
 *  layers — the StackDeck law). */
function EngineBand({ code, active }: { code?: ReactNode[]; active: boolean }) {
  const [step, setStep] = useState(0);
  const [file, setFile] = useState(0); // index within the step's files
  const [pinned, setPinned] = useState(false);

  useEffect(() => {
    if (!active || pinned) return;
    // Never swap the open file on someone who asked motion to stop.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = window.setInterval(() => {
      setStep((s) => (s + 1) % ENGINE_STEPS.length);
      setFile(0);
    }, STEP_DWELL);
    return () => window.clearInterval(id);
  }, [active, pinned]);

  /** Clicking anything pins the band — the reader is driving now. */
  const pick = (i: number) => {
    setStep(i);
    setFile(0);
    setPinned(true);
  };
  const pickFile = (i: number) => {
    setFile(i);
    setPinned(true);
  };

  const stepFiles = FILES_BY_STEP[step] ?? [];

  return (
    <div className="relative z-30">
      {/* The four moments, all legible at once. */}
      <div className="grid grid-cols-4 gap-2.5">
        {ENGINE_STEPS.map((s, i) => (
          <ThermalHover key={s.key} className="h-full" rounded="rounded-lg">
            <button
              type="button"
              aria-pressed={i === step}
              onClick={() => pick(i)}
              className={cn(
                "h-full",
                "relative overflow-hidden rounded-lg border px-4 py-3.5 text-left outline-none backdrop-blur-md transition-colors duration-300 focus-visible:border-white/40",
                i === step
                  ? "border-[#f6483866] bg-[#111116]/90"
                  : "border-[var(--tw-border)] bg-[#0d0d11]/65 hover:border-white/20",
              )}
            >
              <span
                className={cn(
                  "flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.08em] transition-colors duration-300",
                  i === step ? "text-[#f64838]" : "text-white/40",
                )}
              >
                {i === step ? <TitleMark /> : null}
                {s.eyebrow}
              </span>
              <span className="mt-2 block font-medium text-[15px] text-white leading-[20px] tracking-[-0.02em]">
                {s.title}
              </span>
              <span className="mt-1.5 block text-[12.5px] text-white/55 leading-[18px] tracking-[-0.01em]">
                {s.body}
              </span>
              {/* Dwell bar — shows the band's own clock, gone once pinned. */}
              <span
                aria-hidden="true"
                className="absolute inset-x-0 bottom-0 h-px bg-white/[0.07]"
              >
                {i === step ? (
                  <span
                    key={`${s.key}-${pinned}`}
                    className={cn(
                      "block h-full bg-[#f64838]",
                      pinned ? "w-full" : "ps-map-dwell",
                    )}
                    style={
                      pinned
                        ? undefined
                        : { animationDuration: `${STEP_DWELL}ms` }
                    }
                  />
                ) : null}
              </span>
            </button>
          </ThermalHover>
        ))}
      </div>

      {/* The moment, open as a real file. */}
      <div className="mt-4 flex justify-center">
        <div className="relative w-full">
          <ThermalHover rounded="rounded-xl">
            <div className="overflow-hidden rounded-xl border border-white/[0.09] bg-[#0d0d11] shadow-2xl">
              {/* Title bar — matches the hero agent-session window. */}
              <div className="flex items-center gap-3 border-white/[0.07] border-b px-4 py-3">
                <div aria-hidden="true" className="flex items-center gap-1.5">
                  <span className="size-2.5 rounded-full bg-white/[0.12]" />
                  <span className="size-2.5 rounded-full bg-white/[0.12]" />
                  <span className="size-2.5 rounded-full bg-white/[0.12]" />
                </div>
                <span className="font-mono text-[11px] text-white/40 tracking-wide">
                  hogsend — your repo
                </span>
              </div>
              {/* File tabs — the ACTIVE moment's files. Each moment opens as
                  a folder of real files, not one snippet. */}
              <div className="flex flex-wrap items-center gap-1.5 border-white/[0.07] border-b px-3 py-2.5">
                {stepFiles.map((f, i) => (
                  <button
                    key={f.key}
                    type="button"
                    onClick={() => pickFile(i)}
                    className={cn(
                      "shrink-0 cursor-pointer rounded-full border px-3 py-1 font-mono text-[10.5px] transition-colors duration-300",
                      i === file
                        ? "border-[#f64838]/40 bg-[#f64838]/[0.12] text-white"
                        : "border-white/[0.08] text-white/50 hover:border-white/20 hover:text-white/80",
                    )}
                  >
                    {f.file}
                  </button>
                ))}
              </div>
              {/* Editor body: the open file's code — SCROLLABLE, nothing
                  truncated — with the right rail talking through what's
                  actually happening: the moment's live preview on top, the
                  file's narration beneath it. */}
              <div className="relative h-[496px]">
                {ENGINE_STEPS.map((s, si) =>
                  (FILES_BY_STEP[si] ?? []).map((f, fi) => {
                    const isOpen = si === step && fi === file;
                    return (
                      <div
                        key={f.key}
                        className={cn(
                          "absolute inset-0 flex transition-opacity duration-500",
                          isOpen
                            ? "opacity-100"
                            : "pointer-events-none opacity-0",
                        )}
                        aria-hidden={!isOpen}
                      >
                        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 [scrollbar-color:rgba(255,255,255,0.15)_transparent] [scrollbar-width:thin]">
                          {code?.[f.flat] ?? null}
                        </div>
                        <div className="flex w-[320px] shrink-0 flex-col gap-4 overflow-y-auto overscroll-contain border-white/[0.07] border-l bg-white/[0.015] p-3.5 [scrollbar-color:rgba(255,255,255,0.15)_transparent] [scrollbar-width:thin]">
                          {FILE_VISUALS[f.key] ?? s.visual}
                          <div>
                            <p className="mb-2.5 font-mono text-[10px] text-white/40 uppercase tracking-[0.08em]">
                              What's actually happening
                            </p>
                            <ol className="flex flex-col gap-2.5">
                              {f.notes.map((note, ni) => (
                                <li key={note} className="flex gap-2.5">
                                  <span className="mt-[3px] inline-flex size-[15px] shrink-0 items-center justify-center rounded-full bg-white/[0.06] font-mono text-[9px] text-white/50">
                                    {ni + 1}
                                  </span>
                                  <span className="text-[12px] text-white/60 leading-[18px] tracking-[-0.01em]">
                                    {note}
                                  </span>
                                </li>
                              ))}
                            </ol>
                          </div>
                        </div>
                      </div>
                    );
                  }),
                )}
              </div>
            </div>
          </ThermalHover>
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
      className={cn(
        // Desktop only. Seven rails, a bundle, and a fan-out need width;
        // the stacked mobile version was worse than not showing it at all.
        "ps-map relative hidden lg:block",
        active && "is-active",
        className,
      )}
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
        <div className="flex flex-nowrap gap-2.5">
          {SOURCES.map((node) => (
            <NodeChip key={node.label} node={node} side="source" />
          ))}
        </div>
      </div>

      <div aria-hidden="true" className="hidden h-24 lg:block" />

      {/* ------------------------------------------------- the stream -- */}
      {/* z-30: the hero cards sit ABOVE even the front depth strands —
          lines may cross the map, never the main windows. */}
      <div className="relative z-30">
        <StreamCard />
      </div>

      {/* ---------------------------------------------- engine moments -- */}
      <div aria-hidden="true" className="hidden h-16 lg:block" />
      <EngineBand code={code} active={active} />

      <div aria-hidden="true" className="hidden h-16 lg:block" />

      {/* Also reading the stream — the rest of the engine, named. */}
      <p className="relative z-10 text-center font-mono text-[11px] text-white/40 tracking-[-0.01em]">
        also reading the stream: groups · destinations · agents & MCP
      </p>

      <div className="relative z-10 mt-6 flex justify-center">
        <span
          data-map="outlet"
          className="ps-pulse inline-flex size-2 rounded-full bg-[#f64838]"
        />
      </div>

      <div aria-hidden="true" className="hidden h-24 lg:block" />

      {/* ------------------------------------------------ channels, out -- */}
      <div className="relative z-10">
        {/* Sits inside the fan — the pill keeps the strands off the words. */}
        <p className="mb-4 text-center">
          <span className="inline-block rounded-full border border-white/10 bg-[#0d0d11]/85 px-3 py-1 font-mono text-[10px] text-white/45 uppercase tracking-[0.08em] backdrop-blur-md">
            Reach them where they are
          </span>
        </p>
        <div className="flex flex-nowrap gap-2.5">
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

      {/* ------------------------------------------------ steer: studio -- */}
      {/* The cockpit closes the loop: everything above — stream, engine
          moments, channels — is watched and driven from one screen. */}
      <div aria-hidden="true" className="hidden h-16 lg:block" />
      <div className="relative z-30">
        <p className="mb-4 text-center">
          <span className="inline-block rounded-full border border-white/10 bg-[#0d0d11]/85 px-3 py-1 font-mono text-[10px] text-white/45 uppercase tracking-[0.08em] backdrop-blur-md">
            Steer it from Studio
          </span>
        </p>
        <ThermalHover
          rounded="rounded-xl"
          className="mx-auto w-full max-w-[720px]"
        >
          {/* The whole card is the click — it opens the LIVE demo Studio,
              UTM-tagged so the arrival lands in our own attribution. */}
          <a
            href="https://demo.hogsend.com/?utm_source=hogsend.com&utm_medium=landing&utm_campaign=how-it-works&utm_content=steer-station"
            target="_blank"
            rel="noopener"
            className="group/studio block overflow-hidden rounded-xl border border-white/[0.09] bg-[#0d0d11] shadow-2xl transition-colors duration-300 hover:border-white/25"
          >
            <div className="flex items-center justify-between border-white/10 border-b px-4 py-2.5">
              <span className="inline-flex items-center gap-2 font-mono text-[11px] text-white/40 uppercase tracking-[0.08em]">
                <TitleMark />
                studio — a live instance
              </span>
              <span className="font-mono text-[10px] text-white/50 uppercase tracking-[0.08em] transition-colors duration-300 group-hover/studio:text-white">
                open demo.hogsend.com →
              </span>
            </div>
            <div className="grid grid-cols-3 divide-x divide-white/[0.07]">
              {[
                {
                  label: "Journeys",
                  line: "runs parked on waits, branches taken — as it happens",
                },
                {
                  label: "Impact",
                  line: "the +111.8% causal readout above is this demo's",
                },
                {
                  label: "Deals",
                  line: "the pipeline every touch feeds",
                },
              ].map((cell) => (
                <div key={cell.label} className="px-4 py-3.5">
                  <p className="font-medium text-[12.5px] text-white tracking-[-0.02em]">
                    {cell.label}
                  </p>
                  <p className="mt-1 text-[11px] text-white/45 leading-[15px] tracking-[-0.01em]">
                    {cell.line}
                  </p>
                </div>
              ))}
            </div>
          </a>
        </ThermalHover>
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
