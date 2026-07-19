"use client";

import { area as d3Area, line as d3Line } from "d3-shape";
import { useState } from "react";
import { cn } from "@/lib/cn";
import {
  PRODUCT_MONO_VALUE_CLASS,
  PRODUCT_MUTED_CLASS,
  PRODUCT_ROW_LIST_CLASS,
  ProductCard,
  ProductCardFooter,
  ProductCardSection,
  ProductLabel,
  ProductMuted,
  ProductStat,
  ProductTag,
  productRowClass,
  productRowLabelClass,
} from "./product-card";

const DISPLAY = "[font-family:var(--ps-display)]";

/**
 * The impact-experiments readout — the same interactive card anatomy as the
 * flag switcher (`FlagPersonaSwitcher`), built from the same product-card
 * primitives: header with tag + description, a list of selectable rows, a
 * content pane that reacts to the selection, and a mono footer readout.
 *
 * Here the rows are the journey's VERSIONS; selecting one shows the lift that
 * version measured against its holdout — the chart, the confidence, the
 * cohort. Numbers are illustrative (the section caption says so) but
 * internally consistent, and the chart data is deterministic (sine-mixture
 * noise, no RNG) so server and client render identically.
 */

type VersionKey = "v3" | "v2" | "v1";

const VERSION_ORDER: readonly VersionKey[] = ["v3", "v2", "v1"];

interface Version {
  hash: string;
  /** The version live in production (independent of what's selected). */
  current: boolean;
  change: string;
  lift: string | null;
  verdict: "significant" | "inconclusive" | "baseline";
  /** Row-level one-liner. */
  confidence: string | null;
  caption: string;
  stats: {
    confidence: string;
    meter?: number;
    enrolled: string;
    window: string;
  };
  /** Footer readout value. */
  readout: string;
  /** How hard the chart climbs (0–1 of the plot height). */
  climb: number;
  /** Phase offset so each version's noise differs (still deterministic). */
  phase: number;
}

const VERSIONS: Record<VersionKey, Version> = {
  v3: {
    hash: "a1c93f2",
    current: true,
    change: "Add a usage-based nudge before the trial-ending email.",
    lift: "+22%",
    verdict: "significant",
    confidence: "96% confidence",
    caption: "activation lift vs holdout",
    stats: {
      confidence: "96%",
      meter: 0.96,
      enrolled: "8,412",
      window: "14 days",
    },
    readout: "+22% vs holdout",
    climb: 0.9,
    phase: 0,
  },
  v2: {
    hash: "7e0b155",
    current: false,
    change: "Shorten the series from five emails to three.",
    lift: "+6%",
    verdict: "inconclusive",
    confidence: "71% confidence",
    caption: "activation lift vs holdout",
    stats: {
      confidence: "71%",
      meter: 0.71,
      enrolled: "7,948",
      window: "14 days",
    },
    readout: "+6% — not enough signal",
    climb: 0.3,
    phase: 2.1,
  },
  v1: {
    hash: "c3d88a0",
    current: false,
    change: "The first welcome series.",
    lift: null,
    verdict: "baseline",
    confidence: null,
    caption: "the control later versions measure against",
    stats: { confidence: "—", enrolled: "6,204", window: "—" },
    readout: "baseline",
    climb: 0.06,
    phase: 4.2,
  },
};

/* ------------------------------------------------------------- the chart -- */

const CHART_W = 220;
const CHART_H = 96;

const chartY = (v: number) => CHART_H - 10 - v * (CHART_H - 20);

/** Deterministic noisy climb; d3-shape turns it into paths at module scope
 * (computed once, never on render). */
function buildPaths(climb: number, phase: number) {
  const N = 72;
  const pts = Array.from({ length: N }, (_, i) => {
    const t = i / (N - 1);
    const trend = 0.06 + climb * t ** 1.7;
    const wobble =
      Math.sin(i * 0.93 + phase) * 0.028 +
      Math.sin(i * 2.71 + phase * 2) * 0.02 +
      Math.sin(i * 5.31) * 0.012;
    return trend + wobble * (0.35 + t);
  });
  const x = (i: number) => (i / (N - 1)) * CHART_W;
  const lineGen = d3Line<number>()
    .x((_, i) => x(i))
    .y(chartY);
  const areaGen = d3Area<number>()
    .x((_, i) => x(i))
    .y0(CHART_H)
    .y1(chartY);
  return {
    line: lineGen(pts) ?? "",
    fill: areaGen(pts) ?? "",
    end: { x: x(N - 1), y: chartY(pts[N - 1] ?? 0) },
  };
}

const PATHS: Record<VersionKey, ReturnType<typeof buildPaths>> = {
  v3: buildPaths(VERSIONS.v3.climb, VERSIONS.v3.phase),
  v2: buildPaths(VERSIONS.v2.climb, VERSIONS.v2.phase),
  v1: buildPaths(VERSIONS.v1.climb, VERSIONS.v1.phase),
};

/* All versions share one y-scale, so v2's modest climb and v1's flat control
   read against v3's — the comparison is the point. */
const GRID_LINES = [0.15, 0.35, 0.55, 0.75, 0.95].map(chartY);

/** A zero-length round-capped stroke renders as a perfect dot even though the
 * svg stretches (`preserveAspectRatio="none"`) — a circle would go elliptic. */
function SparkDot({
  at,
  color,
}: {
  at: { x: number; y: number };
  color: string;
}) {
  return (
    <path
      d={`M${at.x} ${at.y} l0.01 0`}
      stroke={color}
      strokeWidth={6}
      strokeLinecap="round"
      vectorEffect="non-scaling-stroke"
    />
  );
}

function LiftChart({
  version,
  className,
}: {
  version: VersionKey;
  className?: string;
}) {
  const paths = PATHS[version];
  const baseline = version === "v1";
  return (
    <svg
      aria-hidden="true"
      viewBox={`0 0 ${CHART_W} ${CHART_H}`}
      preserveAspectRatio="none"
      className={className}
    >
      <defs>
        <linearGradient id="hs-impact-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#f64838" stopOpacity="0.30" />
          <stop offset="100%" stopColor="#f64838" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {GRID_LINES.map((gy) => (
        <line
          key={gy}
          x1="0"
          y1={gy}
          x2={CHART_W}
          y2={gy}
          stroke="rgba(255,255,255,0.07)"
          strokeDasharray="2 4"
          vectorEffect="non-scaling-stroke"
        />
      ))}
      <path
        d={paths.fill}
        fill={baseline ? "rgba(255,255,255,0.04)" : "url(#hs-impact-fill)"}
      />
      <path
        d={paths.line}
        fill="none"
        stroke={baseline ? "rgba(255,255,255,0.30)" : "#f64838"}
        strokeWidth="1.6"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
      <SparkDot
        at={paths.end}
        color={baseline ? "rgba(255,255,255,0.45)" : "#f64838"}
      />
    </svg>
  );
}

/* ---------------------------------------------------------- the readout -- */

function VerdictTag({ verdict }: { verdict: Version["verdict"] }) {
  return (
    <ProductTag tone={verdict === "significant" ? "crimzon" : "neutral"}>
      {verdict}
    </ProductTag>
  );
}

export function ImpactReadout() {
  const [selected, setSelected] = useState<VersionKey>("v3");
  const active = VERSIONS[selected];

  return (
    <ProductCard>
      {/* Header — reads like the flag card's: mono name, tag, description.
          (Inlined rather than ProductCardHeader: the live-test tag pulses.) */}
      <div className="border-white/[0.08] border-b px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <code className="min-w-0 truncate font-mono text-[13px] text-white/85">
            activation-welcome
          </code>
          <ProductTag tone="crimzon" pulse>
            live test
          </ProductTag>
        </div>
        <ProductMuted className="mt-1.5">
          Every version ran against a holdout. Select one to read the lift it
          measured on the goal event.
        </ProductMuted>
      </div>

      {/* Version rows — the toggle-list idiom; selecting swaps the readout. */}
      <fieldset
        className={PRODUCT_ROW_LIST_CLASS}
        aria-label="Journey versions"
      >
        {VERSION_ORDER.map((key) => {
          const v = VERSIONS[key];
          const isActive = key === selected;
          return (
            <button
              key={key}
              type="button"
              aria-pressed={isActive}
              onClick={() => setSelected(key)}
              className={cn(
                "text-left outline-none transition-colors",
                productRowClass(isActive),
                !isActive && "hover:bg-white/[0.03]",
              )}
            >
              <span className="flex items-center justify-between gap-3">
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    className={cn(
                      "transition-colors",
                      productRowLabelClass(isActive),
                    )}
                  >
                    {key}
                  </span>
                  <span className="truncate font-mono text-[11px] text-white/35">
                    {v.hash}
                  </span>
                  {v.current && <ProductTag>current</ProductTag>}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  {v.lift && (
                    <span className="font-mono text-[#f64838] text-[12.5px]">
                      {v.lift}
                    </span>
                  )}
                  <VerdictTag verdict={v.verdict} />
                </span>
              </span>
              <span className="mt-1 flex items-baseline justify-between gap-3">
                <span className={cn("min-w-0", PRODUCT_MUTED_CLASS)}>
                  {v.change}
                </span>
                <span className="shrink-0 font-mono text-[11px] text-white/35">
                  {v.confidence ?? "—"}
                </span>
              </span>
            </button>
          );
        })}
      </fieldset>

      {/* The selected version's readout — chart + the stats it stands on. */}
      <ProductCardSection
        className="border-white/[0.08] border-t py-4"
        aria-live="polite"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <ProductLabel>primary goal</ProductLabel>
            <p className="mt-1.5 font-medium text-[13px] text-white tracking-[-0.02em]">
              activation
            </p>
          </div>
          <VerdictTag verdict={active.verdict} />
        </div>

        <div className="mt-4 flex items-end gap-5">
          <div className="shrink-0">
            <p
              className={cn(
                "text-[44px] leading-[1.05] tracking-[-0.02em]",
                DISPLAY,
                active.lift ? "text-[#f64838]" : "text-white/30",
              )}
            >
              {active.lift ?? "—"}
            </p>
            <ProductMuted className="mt-1.5 max-w-[150px]">
              {active.caption}
            </ProductMuted>
          </div>
          <div className="min-w-0 flex-1">
            <LiftChart version={selected} className="h-[64px] w-full" />
          </div>
        </div>

        <div className="mt-4 grid grid-cols-3 divide-x divide-white/[0.08] border-white/[0.08] border-t pt-3">
          <div className="pr-4">
            <ProductStat
              value={active.stats.confidence}
              label="confidence"
              meter={active.stats.meter}
            />
          </div>
          <div className="pl-4">
            <ProductStat value={active.stats.enrolled} label="enrolled users" />
          </div>
          <div className="pl-4">
            <ProductStat
              value={active.stats.window}
              label="experiment window"
            />
          </div>
        </div>
      </ProductCardSection>

      {/* The goal readout — the flag card's "evaluated for you" idiom. */}
      <ProductCardFooter>
        <ProductLabel className="mb-1.5">readout · {selected}</ProductLabel>
        <div
          className={cn("flex items-center gap-2", PRODUCT_MONO_VALUE_CLASS)}
        >
          <span className="text-white/55">activation.completed</span>
          <span className="text-white/30">→</span>
          <span className="min-w-0 truncate text-[#f8a08f]">
            "{active.readout}"
          </span>
        </div>
      </ProductCardFooter>
    </ProductCard>
  );
}
