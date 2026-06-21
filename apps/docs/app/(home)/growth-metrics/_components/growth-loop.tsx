"use client";

import { type JSX, useState } from "react";
import { Section, SectionHeading } from "@/components/ds/section";
import { AnalyticsEvent, capture } from "@/lib/analytics";
import {
  CalcNote,
  CalcPanel,
  clamp,
  Explainer,
  Fig,
  fmtNum,
  MeansForYou,
  NumberField,
  NumberRow,
  Play,
  SectionIntro,
  Slider,
  Stat,
  StatGrid,
  Term,
  type Tone,
} from "./calc-kit";
import { useGrowth } from "./growth-store";

/* -------------------------------------------------------------------------- */
/*  Compounding model                                                         */
/* -------------------------------------------------------------------------- */

/** Total users after `t` complete loop turns, seeded by one `cohort`, each */
/** user bringing `k` more. Converges for k<1, diverges for k≥1. */
function cumAt(t: number, cohort: number, k: number): number {
  if (Math.abs(k - 1) < 1e-9) return cohort * (t + 1);
  return (cohort * (1 - k ** (t + 1))) / (1 - k);
}

/** Cap turns we actually compute so a hyper-viral k can't overflow the chart. */
const MAX_TURNS = 30;

/* ---- chart geometry ---- */
const W = 440;
const H = 240;
const PAD_L = 48;
const PAD_R = 14;
const PAD_T = 16;
const PAD_B = 30;

/* ---- loop diagram ---- */
const CX = 140;
const CY = 140;
const R = 96;
const LOOP_NODES = [
  { angle: -90, label: "New cohort" },
  { angle: 0, label: "They invite" },
  { angle: 90, label: "Friends join" },
  { angle: 180, label: "×K bigger" },
] as const;

function track(): void {
  capture(AnalyticsEvent.CALCULATOR_USED, { calculator: "growth-loop" });
}

export function GrowthLoop(): JSX.Element {
  const { inputs } = useGrowth();

  // K comes from the virality panel above, so the two stay in lockstep.
  const k = clamp(inputs.inv * (inputs.conv / 100), 0, 5);
  const viral = k >= 1;

  const [cohort, setCohort] = useState(100);
  const [cycle, setCycle] = useState(14); // days per loop turn
  const [horizon, setHorizon] = useState(180); // days to project

  const turns = Math.min(Math.floor(horizon / Math.max(cycle, 1)), MAX_TURNS);
  const halfTurns = Math.min(
    Math.floor(horizon / Math.max(cycle / 2, 0.5)),
    MAX_TURNS,
  );

  const total = cumAt(turns, cohort, k);
  const totalHalf = cumAt(halfTurns, cohort, k);
  const ceiling = viral ? Number.POSITIVE_INFINITY : cohort / (1 - k);

  /* ---- chart series ---- */
  type Pt = { x: number; y: number };
  const series: Pt[] = [];
  for (let i = 0; i <= turns; i++) {
    series.push({ x: i * cycle, y: cumAt(i, cohort, k) });
  }
  const seriesHalf: Pt[] = [];
  for (let i = 0; i <= halfTurns; i++) {
    seriesHalf.push({ x: i * (cycle / 2), y: cumAt(i, cohort, k) });
  }

  const maxY = Math.max(total, totalHalf, cohort * 1.2);
  const X = (x: number): number =>
    PAD_L + (x / Math.max(horizon, 1)) * (W - PAD_L - PAD_R);
  const Y = (y: number): number => H - PAD_B - (y / maxY) * (H - PAD_T - PAD_B);

  const toPath = (pts: Pt[]): string =>
    pts.map((p, i) => `${i === 0 ? "M" : "L"}${X(p.x)} ${Y(p.y)}`).join(" ");

  const gridY = Array.from({ length: 4 }, (_u, i) => (maxY * (i + 1)) / 4);
  const tickX = [0, Math.round(horizon / 2), horizon];

  // The loop spins at the cycle-time clock: shorter cycle → faster turn.
  const spin = clamp(cycle * 0.5, 3, 28);
  const kTone: Tone = viral ? "good" : k >= 0.5 ? "caution" : "neutral";

  return (
    <Section id="growth-loop">
      <SectionHeading
        eyebrow="Step 4 · Make it loop"
        title="A loop compounds; a funnel just leaks"
        subtitle="A funnel runs once and drops people at every step. A loop feeds its output back into its input — users invite users — so it turns over and over. How fast it turns is the viral cycle time, and that clock often matters more than the K-factor itself."
      />

      <SectionIntro>
        <p>
          There are four classic loops: <b>viral</b> (users bring users),{" "}
          <b>content</b> (pages bring search traffic that makes more pages),{" "}
          <b>paid</b> (revenue buys ads that make revenue), and <b>sales</b>{" "}
          (revenue funds reps who close more revenue). All share one shape — a{" "}
          <Term id="LOOP">loop</Term> where the output becomes the next input —
          and one dial almost nobody tunes: <Term id="CYCLE">cycle time</Term>,
          how long one turn takes. Halving it doubles how many turns you get in
          a year, which is why it is the exponent&apos;s clock speed.
        </p>
      </SectionIntro>

      <div className="mt-10 grid gap-6 md:grid-cols-2">
        {/* ---- Loop diagram ---- */}
        <CalcPanel className="flex flex-col items-center justify-center">
          <svg
            role="img"
            aria-label="A viral growth loop turning once per cycle"
            viewBox="0 0 280 280"
            className="h-auto w-full max-w-[280px]"
          >
            <title>Viral growth loop</title>
            {/* the loop path */}
            <circle
              cx={CX}
              cy={CY}
              r={R}
              fill="none"
              stroke="var(--color-hairline)"
              strokeWidth={1.5}
              strokeDasharray="3 6"
            />
            {/* orbiting dot — spins at the cycle-time clock */}
            <g
              className="flywheel-rotor"
              style={{
                transformOrigin: `${CX}px ${CY}px`,
                animationDuration: `${spin}s`,
              }}
            >
              <circle cx={CX} cy={CY - R} r={7} fill="var(--color-accent)" />
              <circle
                cx={CX}
                cy={CY - R}
                r={13}
                fill="none"
                stroke="var(--color-accent)"
                strokeWidth={1}
                opacity={0.4}
              />
            </g>
            {/* stage labels */}
            {LOOP_NODES.map((node) => {
              const rad = (node.angle * Math.PI) / 180;
              const x = CX + R * Math.cos(rad);
              const y = CY + R * Math.sin(rad);
              return (
                <g key={node.label}>
                  <rect
                    x={x - 48}
                    y={y - 14}
                    width={96}
                    height={28}
                    rx={8}
                    fill="var(--color-ink)"
                    stroke="var(--color-hairline-faint)"
                    strokeWidth={1}
                  />
                  <text
                    x={x}
                    y={y + 4}
                    textAnchor="middle"
                    fill="#fff"
                    fontSize={12}
                    fontFamily="var(--font-sans)"
                  >
                    {node.label}
                  </text>
                </g>
              );
            })}
            {/* hub */}
            <text
              x={CX}
              y={CY - 4}
              textAnchor="middle"
              fill="var(--color-accent)"
              fontSize={20}
              fontWeight={700}
              fontFamily="var(--font-mono)"
            >
              {`K ${k.toFixed(2)}`}
            </text>
            <text
              x={CX}
              y={CY + 14}
              textAnchor="middle"
              fill="rgba(255,255,255,0.45)"
              fontSize={10}
              fontFamily="var(--font-mono)"
            >
              {`per ${cycle}-day turn`}
            </text>
          </svg>
          <CalcNote className="mt-4 text-center">
            K is read live from the virality panel above —{" "}
            <Fig>{inputs.inv.toFixed(1)}</Fig> invites ×{" "}
            <Fig>{inputs.conv}%</Fig>. Adjust it there; the loop re-times here.
          </CalcNote>
        </CalcPanel>

        {/* ---- Controls + compounding chart ---- */}
        <CalcPanel>
          <NumberRow>
            <NumberField
              label="Starting cohort"
              value={cohort}
              min={1}
              step={10}
              onChange={(v) => {
                setCohort(v);
                track();
              }}
              suffix="users"
            />
          </NumberRow>

          <div className="mt-4">
            <Slider
              label="Viral cycle time"
              value={cycle}
              min={3}
              max={90}
              step={1}
              onChange={setCycle}
              onCommit={track}
              display={`${cycle} days / turn`}
            />
            <Slider
              label="Projection horizon"
              value={horizon}
              min={30}
              max={365}
              step={5}
              onChange={setHorizon}
              onCommit={track}
              display={`${horizon} days`}
            />
          </div>

          <svg
            role="img"
            aria-label="Cumulative users over time as the loop compounds"
            width="100%"
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="xMidYMid meet"
            className="mt-4"
          >
            <title>Cumulative users over time</title>
            {gridY.map((value) => (
              <g key={value}>
                <line
                  x1={PAD_L}
                  y1={Y(value)}
                  x2={W - PAD_R}
                  y2={Y(value)}
                  stroke="var(--color-hairline-faint)"
                  strokeWidth={1}
                />
                <text
                  x={PAD_L - 6}
                  y={Y(value) + 3}
                  textAnchor="end"
                  fill="rgba(255,255,255,0.35)"
                  fontSize={9}
                  fontFamily="var(--font-mono)"
                >
                  {fmtNum(value)}
                </text>
              </g>
            ))}
            {tickX.map((t) => (
              <text
                key={t}
                x={X(t)}
                y={H - PAD_B + 16}
                textAnchor="middle"
                fill="rgba(255,255,255,0.35)"
                fontSize={9}
                fontFamily="var(--font-mono)"
              >
                {`${t}d`}
              </text>
            ))}
            {/* half-cycle (faster clock) — faint comparison */}
            <path
              d={toPath(seriesHalf)}
              fill="none"
              stroke="var(--color-good)"
              strokeWidth={1.5}
              strokeDasharray="4 4"
              strokeLinejoin="round"
              opacity={0.7}
            />
            {/* current cycle */}
            <path
              d={toPath(series)}
              fill="none"
              stroke="var(--color-accent)"
              strokeWidth={2.5}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          </svg>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 font-mono text-[11px] text-white/55">
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-accent" />
              your cycle ({cycle}d)
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-good" />
              half the cycle ({(cycle / 2).toFixed(0)}d)
            </span>
          </div>
        </CalcPanel>
      </div>

      <StatGrid className="mt-6">
        <Stat k="Turns in horizon" n={String(turns)} sub={`${cycle}d each`} />
        <Stat
          k="Total reached"
          n={fmtNum(total)}
          tone="good"
          sub={`from ${fmtNum(cohort)} seed`}
        />
        <Stat
          k={viral ? "Mode" : "Amplification ceiling"}
          n={viral ? "exponential" : fmtNum(ceiling)}
          tone={kTone}
          sub={viral ? "K ≥ 1, no ceiling" : "cohort ÷ (1 − K)"}
        />
        <Stat
          k="Half the cycle →"
          n={fmtNum(totalHalf)}
          tone="good"
          sub="same K, faster clock"
        />
      </StatGrid>

      <MeansForYou tone={kTone}>
        A <Fig>{fmtNum(cohort)}</Fig>-user cohort, each bringing K ={" "}
        <Fig tone={kTone}>{k.toFixed(2)}</Fig> over a <Fig>{cycle}-day</Fig>{" "}
        cycle, snowballs to <Fig tone="good">{fmtNum(total)}</Fig> people in{" "}
        {horizon} days —{" "}
        {viral
          ? "and because K is at or above 1 there is no ceiling, only the clock"
          : `then flattens at its ${fmtNum(ceiling)} amplification ceiling`}
        . Halve the cycle to <Fig>{(cycle / 2).toFixed(0)} days</Fig> and the
        same loop reaches <Fig tone="good">{fmtNum(totalHalf)}</Fig>:{" "}
        {viral
          ? "the same growth, far sooner"
          : "the ceiling arrives roughly twice as fast"}
        . Cycle time is the clock the whole thing runs on — shortening it
        usually beats squeezing out more K.
      </MeansForYou>

      <Play
        moves={[
          "Run a referral program — reward both sides, and trigger the ask at the peak of delivered value, not on day one.",
          "Open an affiliate / partner channel — pay creators or agencies per signup. It is a paid loop that scales on other people's content, and you only pay on conversion.",
          "Make outputs shareable — every export, public link or invite is a free impression that feeds the top of the loop.",
          "Shorten the loop, don't just widen it — cut the time from signup to first invite. Cycle time compounds faster than K.",
        ]}
        consider="an affiliate or creator channel? It is the most underrated B2B loop — other people produce the content and audience, and you pay only when it converts."
      />

      <Explainer summary="Funnel vs loop — and why cycle time wins">
        <p>
          A <b>funnel</b> is a one-way drop-off: 1,000 visitors → 100 signups →
          10 customers, and then it is done. To grow it you have to keep pouring
          new visitors in the top. A <b>loop</b> closes back on itself — those
          10 customers refer the next batch of visitors — so the same effort
          keeps paying out, turn after turn. Channels that never close a loop
          have a hard ceiling; loops compound.
        </p>
        <p>
          The <Term id="KFAC">K-factor</Term> decides whether a loop sustains
          (above 1) or merely <Term id="AMP">amplifies</Term> your paid
          acquisition (below 1). But <b>cycle time</b> decides how fast either
          plays out. Two products with the same K grow at wildly different
          speeds if one loops weekly and the other quarterly — the weekly one
          gets thirteen times as many turns in a year. That is why mature growth
          teams obsess over shortening the invite → activation → re-invite loop,
          not just widening it.
        </p>
      </Explainer>
    </Section>
  );
}
