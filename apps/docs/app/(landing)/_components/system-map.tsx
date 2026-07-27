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

/* ==========================================================================
 *  The system map for the "One stream, one repo" band — a vertical scroll
 *  story that makes the claim literal.
 *
 *  Sources converge DOWN into one stream (the engine card's live ticker);
 *  the stream runs as a spine through four live panels — a durable journey
 *  run, Apollo enrichment filling a contact, a conversion readout, and the
 *  buckets board — then fans out to the channels Hogsend actually ships,
 *  over the thermal-halftone horizon the page closes on.
 *
 *  Pulse dots ride measured bezier paths on a shared 8s clock; a channel
 *  chip flashes when its dot arrives. Everything is CSS keyframes + SMIL
 *  animateMotion — no rAF loop. The overlay SVG is measured from the real
 *  node positions (ResizeObserver) so paths stay anchored at any width;
 *  below lg the overlay hides and dashed spines connect the stacked zones.
 *  Under prefers-reduced-motion everything renders in its settled state
 *  (see home.css, .ps-map rules).
 * ========================================================================== */

const CYCLE = 8; // seconds — one shared clock for dots, flashes, steps

type MapNode = {
  label: string;
  sub: string;
  mark?: string; // /images/logos/<file> silhouette
  icon?: ReactNode;
};

const SOURCES: MapNode[] = [
  { label: "PostHog", sub: "product analytics", mark: "posthog.svg" },
  {
    label: "Your code",
    sub: "hogsend.capture()",
    icon: <Code2 className="size-4" strokeWidth={1.5} />,
  },
  { label: "Segment", sub: "CDP forwarding", mark: "segment.svg" },
  { label: "Stripe", sub: "billing webhooks", mark: "stripe.svg" },
  { label: "Intercom & Fin", sub: "support events", mark: "intercom.svg" },
  {
    label: "Video player",
    sub: "watch-depth signals",
    icon: <Play className="size-4" strokeWidth={1.5} />,
  },
  {
    label: "Webhook sources",
    sub: "any service, one transform",
    icon: <Webhook className="size-4" strokeWidth={1.5} />,
  },
];

const CHANNELS: MapNode[] = [
  { label: "Email", sub: "Resend or Postmark", mark: "resend.svg" },
  { label: "SMS", sub: "Twilio", mark: "twilio.svg" },
  {
    label: "In-app",
    sub: "feed & bell",
    icon: <Bell className="size-4" strokeWidth={1.5} />,
  },
  { label: "Discord", sub: "DMs & channels", mark: "discord.svg" },
  { label: "Telegram", sub: "bot messages", mark: "telegram.svg" },
  {
    label: "Webhooks",
    sub: "your CRM & warehouse",
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

/* Per-source emission times and per-channel departure times on the shared
   clock. Arrival flash = departure + travel. */
const SOURCE_DELAYS = [0, 1.15, 2.3, 3.45, 4.6, 5.75, 6.9];
const CHANNEL_DELAYS = [1.2, 2.5, 3.8, 5.1, 6.4, 7.7];
const CONVERGE_TRAVEL = 1.8;
const FAN_TRAVEL = 1.8;

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
    <div
      data-map={side}
      className={cn(
        "flex items-center gap-2.5 rounded-lg border border-[var(--tw-border)] bg-[var(--tw-card)] px-3 py-2",
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

function PanelFrame({
  eyebrow,
  caption,
  side,
  children,
}: {
  eyebrow: string;
  caption: string;
  side: "left" | "right";
  children: ReactNode;
}) {
  return (
    <div
      data-map="panel"
      data-side={side}
      className={cn(
        "w-full max-w-[430px]",
        side === "left" ? "lg:justify-self-end" : "lg:justify-self-start",
      )}
    >
      <p className="mb-3 font-mono text-[10px] text-white/40 uppercase tracking-[0.08em]">
        {eyebrow}
      </p>
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
    </div>
  );
}

/** A durable journey run — the trace idiom, steps lighting in sequence. */
function JourneysPanel() {
  const steps = [
    { kind: "trigger", label: "user.signup", note: "trigger" },
    { kind: "send", label: "welcome-quickstart", note: "sendEmail" },
    {
      kind: "wait",
      label: "project.created — 3d timeout",
      note: "ctx.waitForEvent · survives deploys",
    },
    {
      kind: "branch",
      label: "timedOut ? nudge : feature-highlight",
      note: "branch on the answer",
    },
  ];
  return (
    <PanelFrame
      eyebrow="Journeys"
      caption="src/journeys/onboarding.ts — a durable run"
      side="left"
    >
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
    </PanelFrame>
  );
}

/** Apollo enrichment — empty contact fields filling in, fill-if-absent. */
function EnrichmentPanel() {
  const fields: Array<[label: string, value: string]> = [
    ["company", "Acme Inc"],
    ["role", "Head of Growth"],
    ["company size", "51–200"],
  ];
  return (
    <PanelFrame
      eyebrow="Enrichment"
      caption="contact — jamie@acme.dev"
      side="right"
    >
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
    </PanelFrame>
  );
}

/** Conversion & attribution readout — arms vs holdout, credit scoped. */
function ConversionsPanel() {
  const rows: Array<[label: string, pct: number, tone: string]> = [
    ["subject-a", 4.1, "bg-white/35"],
    ["subject-b", 5.6, "bg-[#f64838]"],
    ["holdout", 2.3, "bg-white/15"],
  ];
  const max = 6;
  return (
    <PanelFrame
      eyebrow="Conversions"
      caption="trial-conversion — 30d click window"
      side="left"
    >
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
    </PanelFrame>
  );
}

/** The buckets board — lifecycle lanes, a contact moving between them. */
function BucketsPanel() {
  const lanes: Array<{ name: string; cards: string[] }> = [
    { name: "trial", cards: ["sam@", "lee@"] },
    { name: "active", cards: ["kai@"] },
    { name: "dormant", cards: ["mia@"] },
  ];
  return (
    <PanelFrame
      eyebrow="Buckets"
      caption="src/buckets/went-dormant.ts"
      side="right"
    >
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
    </PanelFrame>
  );
}

/* ------------------------------------------------------- measured overlay -- */

type Geometry = {
  w: number;
  h: number;
  converge: string[];
  spine: string;
  taps: string[];
  fan: string[];
};

function vBezier(a: { x: number; y: number }, b: { x: number; y: number }) {
  const dy = b.y - a.y;
  const r = (n: number) => Math.round(n * 10) / 10;
  return `M ${r(a.x)} ${r(a.y)} C ${r(a.x)} ${r(a.y + dy * 0.45)}, ${r(b.x)} ${r(
    b.y - dy * 0.45,
  )}, ${r(b.x)} ${r(b.y)}`;
}

function hBezier(a: { x: number; y: number }, b: { x: number; y: number }) {
  const dx = b.x - a.x;
  const r = (n: number) => Math.round(n * 10) / 10;
  return `M ${r(a.x)} ${r(a.y)} C ${r(a.x + dx * 0.5)} ${r(a.y)}, ${r(
    b.x - dx * 0.5,
  )} ${r(b.y)}, ${r(b.x)} ${r(b.y)}`;
}

function useMapGeometry(ref: React.RefObject<HTMLDivElement | null>) {
  const [geom, setGeom] = useState<Geometry | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const measure = () => {
      // The overlay only exists at lg and up; skip while stacked.
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
      const spineTop = rel(sr.left + sr.width / 2, sr.bottom);
      const spineEnd = rel(or.left + or.width / 2, or.top + or.height / 2);

      const sources = el.querySelectorAll('[data-map="source"]');
      const panels = el.querySelectorAll('[data-map="panel"]');
      const channels = el.querySelectorAll('[data-map="channel"]');

      setGeom({
        w: box.width,
        h: box.height,
        // Gather like a river: sources land on the inlet with a small
        // horizontal spread instead of a single hard point.
        converge: [...sources].map((s, i) => {
          const r = s.getBoundingClientRect();
          return vBezier(rel(r.left + r.width / 2, r.bottom), {
            x: inlet.x + (i - (sources.length - 1) / 2) * 7,
            y: inlet.y,
          });
        }),
        spine: `M ${spineTop.x} ${spineTop.y} L ${spineEnd.x} ${spineEnd.y}`,
        taps: [...panels].map((p) => {
          const r = p.getBoundingClientRect();
          const side = (p as HTMLElement).dataset.side;
          const midY = r.top + r.height / 2 - box.top;
          const edgeX =
            side === "left" ? r.right - box.left : r.left - box.left;
          return hBezier({ x: spineTop.x, y: midY }, { x: edgeX, y: midY });
        }),
        fan: [...channels].map((c) => {
          const r = c.getBoundingClientRect();
          return vBezier(spineEnd, rel(r.left + r.width / 2, r.top));
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

/* ------------------------------------------------------------- component -- */

export function SystemMap({ className }: { className?: string }) {
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
      <div className="relative z-10">
        <StreamCard />
      </div>

      <MobileSpine />
      <div aria-hidden="true" className="hidden h-20 lg:block" />

      {/* ---------------------------------------------- engine panels -- */}
      <div className="relative">
        <div className="relative z-10 grid grid-cols-1 items-center gap-y-12 lg:grid-cols-2 lg:gap-x-40 lg:gap-y-16">
          <JourneysPanel />
          <div className="hidden lg:block" />
          <div className="hidden lg:block" />
          <EnrichmentPanel />
          <ConversionsPanel />
          <div className="hidden lg:block" />
          <div className="hidden lg:block" />
          <BucketsPanel />
        </div>
      </div>

      <MobileSpine />
      <div aria-hidden="true" className="hidden h-20 lg:block" />

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

      {/* ------------------------------------------------ channels, out --
          The thermal-halftone horizon behind this zone is painted full-bleed
          at the SECTION level (PsManifesto) so it reaches the viewport
          edges — only content lives here. */}
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

      {/* -------------------------------------------- measured overlay -- */}
      {geom ? (
        <svg
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-[5] hidden lg:block"
          width={geom.w}
          height={geom.h}
          viewBox={`0 0 ${geom.w} ${geom.h}`}
          fill="none"
        >
          {[...geom.converge, geom.spine, ...geom.taps, ...geom.fan].map(
            (d, i) => (
              <path
                // biome-ignore lint/suspicious/noArrayIndexKey: positional geometry
                key={i}
                d={d}
                pathLength={1}
                className="ps-map-path"
                stroke="rgba(255,255,255,0.18)"
                strokeWidth={1}
                style={{ animationDelay: `${i * 0.05}s` }}
              />
            ),
          )}
          {active && (
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
              {/* The spine carries a steady pulse train — always moving. */}
              {[0, 1, 2].map((i) => (
                <g key={`s${i}`} className="ps-map-dot-solid">
                  <circle r={2.5} fill="#f64838">
                    <animateMotion
                      dur="4s"
                      begin={`${(-4 / 3) * i}s`}
                      repeatCount="indefinite"
                      calcMode="linear"
                      path={geom.spine}
                    />
                  </circle>
                </g>
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
          )}
        </svg>
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
