"use client";

import type { JSX } from "react";
import { Section, SectionHeading } from "@/components/ds/section";
import { AnalyticsEvent, capture } from "@/lib/analytics";
import { cn } from "@/lib/cn";
import {
  CalcPanel,
  Explainer,
  Fig,
  fmtNum,
  Hint,
  MeansForYou,
  NumberField,
  NumberRow,
  Play,
  SectionIntro,
  Slider,
  Stat,
  StatGrid,
  Term,
  useCurrency,
  useMoney,
} from "./calc-kit";
import { useGrowth } from "./growth-store";

/* -------------------------------------------------------------------------- */
/*  Chart geometry                                                            */
/* -------------------------------------------------------------------------- */

const W = 440;
const H = 260;
const PAD_L = 52;
const PAD_R = 14;
const PAD_T = 16;
const PAD_B = 34;

/** Marginal-scale samples: 1× → 10× in 0.25× steps. */
const SAMPLE_MS: number[] = (() => {
  const out: number[] = [];
  for (let m = 1; m <= 10.0001; m += 0.25) out.push(Math.round(m * 100) / 100);
  return out;
})();

const X_TICKS = [1, 4, 7, 10] as const;

function track(): void {
  capture(AnalyticsEvent.CALCULATOR_USED, { calculator: "blended-cac" });
}

export function BlendedCac(): JSX.Element {
  const money = useMoney();
  const { symbol } = useCurrency();

  const { inputs, setField } = useGrowth();
  const spend = inputs.pSpend;
  const pc = inputs.pCust;
  const oc = inputs.oCust;
  const m = inputs.scale;
  const sat = inputs.sat;

  /** The model: marginal-paid CAC and blended CAC at scale factor `mm`. */
  function blendAt(mm: number): { paidCACm: number; blended: number } {
    const satRate = sat / 100;
    const paidCACm = (spend / Math.max(pc, 1)) * (1 + satRate * (mm - 1));
    const paidSpendm = paidCACm * pc * mm;
    const paidCustm = pc * mm;
    const blended = paidSpendm / (paidCustm + oc);
    return { paidCACm, blended };
  }

  const { paidCACm, blended } = blendAt(m);
  const gap = paidCACm - blended;
  const gapTone = gap > paidCACm * 0.3 ? "warn" : "caution";

  /* --- chart data ------------------------------------------------------- */

  const samples = SAMPLE_MS.map((mm) => ({ mm, ...blendAt(mm) }));

  let maxY = 0;
  let minY = Number.POSITIVE_INFINITY;
  for (const s of samples) {
    maxY = Math.max(maxY, s.blended, s.paidCACm);
    minY = Math.min(minY, s.blended);
  }
  maxY = maxY * 1.08;
  minY = minY * 0.92;
  const span = Math.max(maxY - minY, 1);

  const X = (mm: number): number =>
    PAD_L + ((mm - 1) / 9) * (W - PAD_L - PAD_R);
  const Y = (v: number): number =>
    H - PAD_B - ((v - minY) / span) * (H - PAD_T - PAD_B);

  const gridValues = Array.from(
    { length: 5 },
    (_unused, i) => minY + (span * i) / 4,
  );

  const paidD = samples
    .map((s, i) => `${i === 0 ? "M" : "L"}${X(s.mm)} ${Y(s.paidCACm)}`)
    .join(" ");
  const blendedD = samples
    .map((s, i) => `${i === 0 ? "M" : "L"}${X(s.mm)} ${Y(s.blended)}`)
    .join(" ");

  return (
    <Section id="blended-cac">
      <SectionHeading
        eyebrow="Step 5 · Buy honestly"
        title="Blended CAC flatters; marginal CAC decides"
        subtitle={
          <>
            <Term id="BLENDED">Blended CAC</Term> folds free organic into the
            denominator, so it understates the cost of the customer your next
            budget actually buys. Scale paid spend: organic stays fixed, paid
            grows, and blended drifts up to meet <Term id="PAID">paid CAC</Term>
            .
          </>
        }
      />

      <SectionIntro>
        <p>
          Every business mixes two kinds of customer: the ones you pay to
          acquire, and the ones who arrive free — word of mouth, search,
          referrals. <b>Blended CAC</b> averages the cost across both;{" "}
          <b>paid CAC</b> counts only the bought ones. The averaged number is
          the one people quote on stage, and it is the one that quietly lies to
          you the day you decide to scale spend.
        </p>
      </SectionIntro>

      <div className="mt-10 grid gap-6 md:grid-cols-2">
        {/* ---- Inputs ---- */}
        <CalcPanel>
          <NumberRow>
            <NumberField
              label="Paid spend / mo"
              value={spend}
              onChange={(v) => {
                setField("pSpend", v);
                track();
              }}
              min={0}
              step={1000}
              prefix={symbol}
            />
            <NumberField
              label="Paid customers"
              value={pc}
              onChange={(v) => {
                setField("pCust", v);
                track();
              }}
              min={1}
              step={10}
            />
            <NumberField
              label="Organic customers"
              value={oc}
              onChange={(v) => {
                setField("oCust", v);
                track();
              }}
              min={0}
              step={10}
            />
          </NumberRow>

          <div className="mt-5">
            <Slider
              label="Scale paid spend"
              value={m}
              min={1}
              max={10}
              step={0.25}
              onChange={(v) => setField("scale", v)}
              onCommit={track}
              display={`${m.toFixed(2)}× paid`}
            />
            <Slider
              label="Saturation — marginal CAC inflation / ×"
              labelNode={
                <>
                  Saturation — <Term id="MARGINAL">marginal</Term> CAC inflation
                  / ×
                </>
              }
              value={sat}
              min={0}
              max={25}
              step={1}
              onChange={(v) => setField("sat", v)}
              onCommit={track}
              display={`+${sat}% / ×`}
            />
          </div>

          <StatGrid className="mt-5">
            <Stat
              k={<Term id="PAID">Paid CAC</Term>}
              n={money(paidCACm)}
              tone="warn"
              sub="cost of a bought customer"
            />
            <Stat
              k={<Term id="BLENDED">Blended CAC</Term>}
              n={money(blended)}
              tone="caution"
              sub="total spend ÷ all customers"
            />
            <Stat
              k="Gap"
              n={money(gap)}
              tone={gapTone}
              sub="how much blended hides"
            />
          </StatGrid>
        </CalcPanel>

        {/* ---- Chart ---- */}
        <CalcPanel>
          <svg
            role="img"
            aria-label="Blended CAC rising toward paid CAC as spend scales"
            width="100%"
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="xMidYMid meet"
          >
            {/* gridlines + y-axis labels */}
            {gridValues.map((value) => (
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
                  {symbol + fmtNum(value)}
                </text>
              </g>
            ))}

            {/* x-axis labels */}
            {X_TICKS.map((tick) => (
              <text
                key={tick}
                x={X(tick)}
                y={H - PAD_B + 18}
                textAnchor="middle"
                fill="rgba(255,255,255,0.35)"
                fontSize={9}
                fontFamily="var(--font-mono)"
              >
                {`${tick}×`}
              </text>
            ))}

            {/* current-scale marker */}
            <line
              x1={X(m)}
              y1={PAD_T}
              x2={X(m)}
              y2={H - PAD_B}
              stroke="white"
              strokeOpacity={0.45}
              strokeWidth={1}
              strokeDasharray="3 4"
            />

            {/* series */}
            <path
              d={blendedD}
              fill="none"
              stroke="var(--color-caution)"
              strokeWidth={2.5}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            <path
              d={paidD}
              fill="none"
              stroke="var(--color-accent)"
              strokeWidth={2.5}
              strokeLinejoin="round"
              strokeLinecap="round"
            />

            {/* current points */}
            <circle
              cx={X(m)}
              cy={Y(blended)}
              r={4}
              fill="var(--color-caution)"
            />
            <circle
              cx={X(m)}
              cy={Y(paidCACm)}
              r={4}
              fill="var(--color-accent)"
            />
          </svg>

          {/* legend */}
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 font-mono text-[11px] text-white/55">
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-caution" />
              Blended CAC
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-accent" />
              Paid CAC (marginal)
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-white/40" />
              your scale point
            </span>
          </div>
        </CalcPanel>
      </div>

      <MeansForYou tone="caution">
        Right now you spend <Fig>{money(spend)}</Fig> a month to win{" "}
        <Fig>{fmtNum(pc)}</Fig> paid customers, with <Fig>{fmtNum(oc)}</Fig>{" "}
        more arriving free. So each <em>bought</em> customer actually costs{" "}
        <Fig tone="warn">{money(paidCACm)}</Fig> — but your free organic
        customers pull the blended average down to{" "}
        <Fig tone="caution">{money(blended)}</Fig>, a <Fig>{money(gap)}</Fig>{" "}
        gap. Budget against the <Fig tone="warn">{money(paidCACm)}</Fig>: the
        moment you scale paid, the free customers stop hiding it and your real
        cost surfaces.
      </MeansForYou>

      <Play
        moves={[
          "Diversify channels so no single ad auction can spike your blended cost overnight.",
          "Build a real organic loop (content / SEO, community, referrals) so blended sits below paid for a reason, not an accident.",
          "Judge every new pound on incrementality — a holdout or geo-test — not last-click attribution.",
        ]}
        consider="running a holdout before you trust an attribution dashboard? Most 'attributed' conversions would have happened anyway — incrementality is the only honest read."
      />

      {/* ---- Three rules ---- */}
      <div className="mt-8">
        <h3 className="mb-3 text-[11px] text-white/50 uppercase tracking-[0.07em]">
          Three rules
        </h3>
        <ul className="flex flex-col gap-3">
          {[
            "Report blended to the board — it is the true cost-to-grow and dodges attribution fights.",
            "Budget on marginal / paid CAC — adding spend is judged by what THAT spend brings, not the average your free traffic drags down.",
            "Watch the gap close — if blended is creeping toward paid, your organic engine has stopped scaling and you are a paid-acquisition business now.",
          ].map((rule, index) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: static, never reordered
              key={index}
              className={cn("flex gap-3 text-sm text-white/60 leading-6")}
            >
              <span className="mt-2 size-1.5 shrink-0 rounded-full bg-accent" />
              <span>{rule}</span>
            </li>
          ))}
        </ul>
      </div>

      <Hint>
        {`The classic blow-up: "our CAC is ${symbol}40!" (blended) → triple paid spend → CAC "mysteriously" climbs to ${symbol}90. It did not climb; you stopped hiding paid behind organic and hit saturation at the same time.`}
      </Hint>

      <Explainer summary="What am I looking at in this chart?">
        <p>
          The x-axis is how much you scale paid spend — from <b>1×</b> (today)
          out to <b>10×</b>. The gold line is your <b>blended CAC</b> and the
          coral line is your <b>paid CAC</b>. The gap between them where they
          start is the discount your free organic customers quietly give you:
          they cost nothing to acquire, so they pull the average down.
        </p>
        <p>
          As you scale, your organic numbers stay fixed while paid balloons, so
          the average gets dragged toward paid and the gold line climbs to meet
          the coral one. That is the whole lesson:{" "}
          <b>report blended to the board, but budget on paid</b>. Turning up
          saturation tilts the coral line upward too, because once the easy
          audience is spent each extra pound buys a pricier customer.
        </p>
        <p>
          This is exactly how founders get blindsided. {`"our CAC is `}
          {symbol}
          {`40!"`} (that is blended) → they triple the budget →{" "}
          {`"why is CAC suddenly `}
          {symbol}
          {`90?"`}. It did not jump. You simply stopped hiding paid behind free
          organic, and the average had nowhere left to hide.
        </p>
      </Explainer>
    </Section>
  );
}
