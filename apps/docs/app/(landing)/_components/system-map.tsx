"use client";

import { Bell, Code2, Play, Webhook } from "lucide-react";
import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/cn";

/* ==========================================================================
 *  The system map for the "One stream, one repo" band.
 *
 *  Makes the claim literal: seven source nodes converge into ONE stream
 *  (the engine card's live event ticker), and the stream fans out to the
 *  channels Hogsend actually ships. Pulse dots ride measured bezier paths
 *  on a shared 8s clock; a channel chip flashes when its dot arrives.
 *
 *  Everything is CSS keyframes + SMIL animateMotion — no rAF loop. The
 *  overlay SVG is measured from the real chip positions (ResizeObserver),
 *  so the paths stay anchored at every breakpoint. Under
 *  prefers-reduced-motion the paths render drawn and the dots/ticker stop
 *  (see home.css, .ps-map rules).
 * ========================================================================== */

const CYCLE = 8; // seconds — one shared clock for dots, flashes, chips

type SourceNode = {
  label: string;
  sub: string;
  mark?: string; // /images/logos/<file> silhouette
  icon?: ReactNode;
};

const SOURCES: SourceNode[] = [
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

type ChannelNode = SourceNode;

const CHANNELS: ChannelNode[] = [
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

/* What the engine does with the stream — every chip is shipped product. */
const ENGINE_CHIPS = [
  "Durable journeys",
  "Conversions & attribution",
  "Buckets & audiences",
  "Enrichment · Apollo",
  "Groups",
  "Flags",
  "Broadcasts",
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
   clock. Arrival flash = departure + travel (see RIGHT_TRAVEL). */
const LEFT_DELAYS = [0, 1.15, 2.3, 3.45, 4.6, 5.75, 6.9];
const RIGHT_DELAYS = [1.2, 2.5, 3.8, 5.1, 6.4, 7.7];
const LEFT_TRAVEL = 2.4;
const RIGHT_TRAVEL = 2.0;

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
  node: SourceNode;
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

function EngineCard({ mapAnchor }: { mapAnchor?: boolean }) {
  return (
    <div
      data-map={mapAnchor ? "engine" : undefined}
      className="relative rounded-xl border border-[#f6483833] bg-[#120607]/80 shadow-[0_0_60px_rgba(246,72,56,0.07)]"
    >
      <div className="flex items-center justify-between border-[var(--tw-border)] border-b px-4 py-3">
        <span className="flex items-center gap-2">
          <span className="ps-pulse size-1.5 rounded-full bg-[#f64838]" />
          <span className="font-medium text-[13px] text-white tracking-[-0.02em]">
            Hogsend engine
          </span>
        </span>
        <span className="font-mono text-[10px] text-white/40 uppercase tracking-[0.08em]">
          in your repo
        </span>
      </div>

      {/* The one stream — a live ticker of the merged event feed. */}
      <div
        className="relative h-[104px] overflow-hidden px-4"
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

      <div className="border-[var(--tw-border)] border-t px-4 py-3.5">
        <p className="mb-2.5 font-mono text-[10px] text-white/40 uppercase tracking-[0.08em]">
          What the stream feeds
        </p>
        <div className="flex flex-wrap gap-1.5">
          {ENGINE_CHIPS.map((chip, i) => (
            <span
              key={chip}
              className="ps-map-chip rounded-full border border-[var(--tw-border)] px-2.5 py-1 text-[11px] text-white/60 tracking-[-0.01em]"
              style={{
                animationDelay: `${(i * CYCLE) / ENGINE_CHIPS.length}s`,
              }}
            >
              {chip}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------- measured overlay -- */

type Geometry = {
  w: number;
  h: number;
  left: string[];
  right: string[];
};

function bezier(a: { x: number; y: number }, b: { x: number; y: number }) {
  const dx = b.x - a.x;
  const r = (n: number) => Math.round(n * 10) / 10;
  return `M ${r(a.x)} ${r(a.y)} C ${r(a.x + dx * 0.45)} ${r(a.y)}, ${r(
    b.x - dx * 0.45,
  )} ${r(b.y)}, ${r(b.x)} ${r(b.y)}`;
}

function useMapGeometry(ref: React.RefObject<HTMLDivElement | null>) {
  const [geom, setGeom] = useState<Geometry | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const measure = () => {
      const box = el.getBoundingClientRect();
      if (box.width === 0) return;
      const engine = el.querySelector('[data-map="engine"]');
      if (!engine) return;
      const er = engine.getBoundingClientRect();
      const rel = (x: number, y: number) => ({
        x: x - box.left,
        y: y - box.top,
      });

      const sources = el.querySelectorAll('[data-map="source"]');
      const channels = el.querySelectorAll('[data-map="channel"]');
      const inletX = er.left;
      const inletY = er.top + er.height / 2;
      const outlet = rel(er.right, inletY);

      setGeom({
        w: box.width,
        h: box.height,
        // Gather like a river: each source lands on the inlet with a small
        // vertical spread instead of a single hard point.
        left: [...sources].map((s, i) => {
          const r = s.getBoundingClientRect();
          return bezier(
            rel(r.right, r.top + r.height / 2),
            rel(inletX, inletY + (i - (sources.length - 1) / 2) * 7),
          );
        }),
        right: [...channels].map((c) => {
          const r = c.getBoundingClientRect();
          return bezier(outlet, rel(r.left, r.top + r.height / 2));
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
      { threshold: 0.25 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const geom = useMapGeometry(mapRef);

  return (
    <div className={className}>
      {/* Desktop: three lanes with the measured path overlay. */}
      <div
        ref={mapRef}
        className={cn("ps-map relative hidden lg:block", active && "is-active")}
      >
        <div className="relative z-10 grid grid-cols-[200px_minmax(72px,1fr)_340px_minmax(72px,1fr)_220px] items-center">
          <div className="flex flex-col gap-2.5 py-2">
            <p className="mb-1 font-mono text-[10px] text-white/40 uppercase tracking-[0.08em]">
              Everything in
            </p>
            {SOURCES.map((node) => (
              <NodeChip key={node.label} node={node} side="source" />
            ))}
          </div>
          <div />
          <EngineCard mapAnchor />
          <div />
          <div className="flex flex-col gap-2.5 py-2">
            <p className="mb-1 font-mono text-[10px] text-white/40 uppercase tracking-[0.08em]">
              Reach them where they are
            </p>
            {CHANNELS.map((node, i) => (
              <NodeChip
                key={node.label}
                node={node}
                side="channel"
                flashDelay={RIGHT_DELAYS[i] + RIGHT_TRAVEL - 0.2}
              />
            ))}
          </div>
        </div>

        {geom ? (
          <svg
            aria-hidden="true"
            className="pointer-events-none absolute inset-0"
            width={geom.w}
            height={geom.h}
            viewBox={`0 0 ${geom.w} ${geom.h}`}
            fill="none"
          >
            {[...geom.left, ...geom.right].map((d, i) => (
              <path
                // biome-ignore lint/suspicious/noArrayIndexKey: positional geometry
                key={i}
                d={d}
                pathLength={1}
                className="ps-map-path"
                stroke="rgba(255,255,255,0.18)"
                strokeWidth={1}
                style={{ animationDelay: `${i * 0.06}s` }}
              />
            ))}
            {active && (
              <g className="ps-map-dots">
                {geom.left.map((d, i) => (
                  <g
                    // biome-ignore lint/suspicious/noArrayIndexKey: positional geometry
                    key={`l${i}`}
                    className="ps-map-dot"
                    style={{ animationDelay: `${LEFT_DELAYS[i]}s` }}
                  >
                    <circle r={2.5} fill="#f64838">
                      <animateMotion
                        dur={`${CYCLE}s`}
                        begin={`${LEFT_DELAYS[i]}s`}
                        repeatCount="indefinite"
                        calcMode="linear"
                        keyPoints={`0;1;1`}
                        keyTimes={`0;${LEFT_TRAVEL / CYCLE};1`}
                        path={d}
                      />
                    </circle>
                  </g>
                ))}
                {geom.right.map((d, i) => (
                  <g
                    // biome-ignore lint/suspicious/noArrayIndexKey: positional geometry
                    key={`r${i}`}
                    className="ps-map-dot"
                    style={{ animationDelay: `${RIGHT_DELAYS[i]}s` }}
                  >
                    <circle r={2.5} fill="#f64838">
                      <animateMotion
                        dur={`${CYCLE}s`}
                        begin={`${RIGHT_DELAYS[i]}s`}
                        repeatCount="indefinite"
                        calcMode="linear"
                        keyPoints={`0;1;1`}
                        keyTimes={`0;${RIGHT_TRAVEL / CYCLE};1`}
                        path={d}
                      />
                    </circle>
                  </g>
                ))}
              </g>
            )}
          </svg>
        ) : null}
      </div>

      {/* Mobile: the same three moments stacked, connected by drifting
          dashed spines. */}
      <div className="ps-map is-active lg:hidden">
        <p className="mb-3 font-mono text-[10px] text-white/40 uppercase tracking-[0.08em]">
          Everything in
        </p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {SOURCES.map((node) => (
            <NodeChip key={node.label} node={node} side="source" />
          ))}
        </div>
        <MobileSpine />
        <EngineCard />
        <MobileSpine />
        <p className="mb-3 font-mono text-[10px] text-white/40 uppercase tracking-[0.08em]">
          Reach them where they are
        </p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {CHANNELS.map((node, i) => (
            <NodeChip
              key={node.label}
              node={node}
              side="channel"
              flashDelay={RIGHT_DELAYS[i] + RIGHT_TRAVEL - 0.2}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function MobileSpine() {
  return (
    <div className="flex justify-center py-1">
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
