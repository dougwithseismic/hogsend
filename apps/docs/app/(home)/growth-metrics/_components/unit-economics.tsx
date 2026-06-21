"use client";

import type { JSX } from "react";
import { Section, SectionHeading } from "@/components/ds/section";
import { AnalyticsEvent, capture } from "@/lib/analytics";
import { cn } from "@/lib/cn";
import {
  CalcPanel,
  clamp,
  Explainer,
  Fig,
  fmtPct,
  Hint,
  MeansForYou,
  Play,
  RippleChain,
  SectionIntro,
  Slider,
  Stat,
  StatGrid,
  Term,
  TONE_VAR,
  type Tone,
  useMoney,
  Verdict,
} from "./calc-kit";
import { useGrowth } from "./growth-store";

const CALCULATOR_ID = "unit-economics";

function commit(): void {
  capture(AnalyticsEvent.CALCULATOR_USED, { calculator: CALCULATOR_ID });
}

/** Eight evenly-spaced spoke angles for the flywheel rotor. */
const SPOKES = Array.from({ length: 8 }, (_, i) => (i / 8) * 2 * Math.PI);

/**
 * Unit-economics calculator — the core retention → LTV → acquisition-budget
 * loop. Four sliders (ARPA, gross margin, monthly churn, CAC) drive a live
 * flywheel whose spin rate tracks LTV:CAC health, a ripple chain that
 * recolours as the maths cascades, and payback / headroom stats. Fires
 * `docs.calculator_used` on slider release only.
 */
export function UnitEconomics(): JSX.Element {
  const money = useMoney();
  const { inputs, setField } = useGrowth();

  const arpa = inputs.arpa;
  const gm = inputs.gmPct;
  const churn = inputs.churnPct;
  const cac = inputs.cac;

  const g = gm / 100;
  const c = churn / 100;

  const life = 1 / c;
  const ltv = (arpa * g) / c;
  const ratio = ltv / cac;
  const ceiling = ltv / 3;
  const payback = cac / (arpa * g);
  const headroom = ceiling - cac;

  let state: Tone;
  let label: string;
  if (ratio < 1) {
    state = "warn";
    label = "Underwater — you are burning cash";
  } else if (ratio < 3) {
    state = "caution";
    label = "Works, but thin — push the ratio or fix payback";
  } else if (ratio <= 5) {
    state = "good";
    label = "Healthy band (3–5:1)";
  } else {
    state = "caution";
    label = "Under-investing — leaving growth on the table";
  }

  const toneVar = TONE_VAR[state];
  const dur = clamp(14 - ratio * 1.6, 2.2, 13);

  const meaning =
    ratio < 1 ? (
      <>
        That is <Fig tone="warn">underwater</Fig> — you lose money on every
        customer you buy. Bring churn or CAC down before you spend another pound
        on acquisition.
      </>
    ) : ratio < 3 ? (
      <>
        It works, but it is thin. You could afford up to{" "}
        <Fig>{money(ceiling)}</Fig> per customer and you are paying{" "}
        <Fig>{money(cac)}</Fig>, so push the ratio or speed up the{" "}
        <Fig>{payback.toFixed(1)}-month</Fig> payback.
      </>
    ) : ratio <= 5 ? (
      <>
        That is the healthy band. You could pay up to{" "}
        <Fig tone="good">{money(ceiling)}</Fig> per customer and still clear 3:1
        — about <Fig tone="good">{money(headroom)}</Fig> of headroom to spend
        harder on growth, recouped in <Fig>{payback.toFixed(1)} months</Fig>.
      </>
    ) : (
      <>
        That is almost too cautious. You could pay up to{" "}
        <Fig>{money(ceiling)}</Fig> per customer — you only pay{" "}
        <Fig>{money(cac)}</Fig> — and still hit 3:1, so there is room to invest
        more and grow faster.
      </>
    );

  const nodes = [
    {
      k: <Term id="CHURN">Churn /mo</Term>,
      n: `${churn.toFixed(1)}%`,
      d: "the input",
      tone: (churn > 6 ? "warn" : churn > 3 ? "caution" : "good") as Tone,
    },
    {
      k: <Term id="LIFETIME">Lifetime</Term>,
      n: `${life.toFixed(0)} mo`,
      d: "1 ÷ churn",
      tone: (life < 8 ? "warn" : life < 18 ? "caution" : "good") as Tone,
    },
    {
      k: <Term id="LTV">LTV</Term>,
      n: money(ltv),
      d: "ARPA·GM·life",
      tone: "good" as Tone,
    },
    {
      k: <Term id="RATIO">LTV : CAC</Term>,
      n: `${ratio.toFixed(1)}:1`,
      d: "LTV ÷ CAC",
      tone: state,
    },
    {
      k: <Term id="CEILING">Affordable CAC</Term>,
      n: money(ceiling),
      d: "LTV ÷ 3",
      tone: (headroom < 0
        ? "warn"
        : headroom < cac * 0.2
          ? "caution"
          : "good") as Tone,
    },
  ];

  return (
    <Section id="unit-economics">
      <SectionHeading
        eyebrow="Step 2 · The engine room"
        title="Churn sets your LTV, and LTV sets your acquisition budget"
        subtitle="LTV = ARPA × gross margin ÷ churn. Churn sits in the denominator, so it is the highest-leverage input you have. Drag a slider; watch the chain and the flywheel react."
      />

      <SectionIntro>
        <p>
          This is the engine room. Four numbers — what a customer pays, your
          margin, how fast customers leave, and what each one costs to win —
          decide whether growth pays for itself. The piece most people miss is
          that <b>churn sits in the denominator of lifetime value</b>, so
          shaving it does far more than nudging price ever could.
        </p>
        <p>
          Drag any slider and watch the change ripple all the way along the
          chain to the single most useful number here: the most you can afford
          to pay for a customer.
        </p>
      </SectionIntro>

      <div className="mt-10 grid gap-6 md:grid-cols-2">
        <CalcPanel>
          <Slider
            label="ARPA — revenue per customer / mo"
            labelNode={
              <>
                <Term id="ARPA">ARPA</Term> — revenue per customer / mo
              </>
            }
            value={arpa}
            min={5}
            max={Math.max(2000, Math.ceil(arpa * 1.25))}
            step={5}
            onChange={(v) => setField("arpa", v)}
            onCommit={commit}
            display={money(arpa)}
          />
          <Slider
            label="Gross margin"
            labelNode={<Term id="GM">Gross margin</Term>}
            value={gm}
            min={10}
            max={95}
            step={1}
            onChange={(v) => setField("gmPct", v)}
            onCommit={commit}
            display={fmtPct(gm)}
          />
          <Slider
            label="Monthly churn"
            labelNode={<Term id="CHURN">Monthly churn</Term>}
            value={churn}
            min={0.2}
            max={20}
            step={0.1}
            onChange={(v) => setField("churnPct", v)}
            onCommit={commit}
            display={`${churn.toFixed(1)}%`}
          />
          <Slider
            label="CAC — fully loaded"
            labelNode={
              <>
                <Term id="CAC">CAC</Term> — fully loaded
              </>
            }
            value={cac}
            min={10}
            max={Math.max(10000, Math.ceil(cac * 1.25))}
            step={10}
            onChange={(v) => setField("cac", v)}
            onCommit={commit}
            display={money(cac)}
          />
        </CalcPanel>

        <CalcPanel className="flex flex-col items-center justify-center">
          <svg
            role="img"
            aria-label="Growth flywheel; spin rate reflects LTV:CAC health"
            viewBox="0 0 260 260"
            className="h-auto w-full max-w-[260px]"
          >
            <circle
              cx={130}
              cy={130}
              r={116}
              fill="none"
              stroke="var(--color-hairline)"
              strokeWidth={1}
            />
            <g
              className="flywheel-rotor"
              style={{
                transformOrigin: "130px 130px",
                animationDuration: `${dur}s`,
                animationPlayState: ratio < 1 ? "paused" : "running",
              }}
            >
              <circle
                cx={130}
                cy={130}
                r={92}
                fill="none"
                stroke={toneVar}
                strokeWidth={1}
                strokeDasharray="2 7"
                opacity={0.55}
              />
              {SPOKES.map((angle) => (
                <line
                  key={angle}
                  x1={130 + 30 * Math.cos(angle)}
                  y1={130 + 30 * Math.sin(angle)}
                  x2={130 + 92 * Math.cos(angle)}
                  y2={130 + 92 * Math.sin(angle)}
                  stroke={toneVar}
                  strokeWidth={2}
                  strokeLinecap="round"
                  opacity={0.7}
                />
              ))}
              <circle
                cx={130}
                cy={130}
                r={30}
                fill="rgba(255,255,255,0.04)"
                stroke={toneVar}
                strokeWidth={1.5}
              />
            </g>
            <circle cx={130} cy={130} r={9} fill={toneVar} />
          </svg>

          <div className="mt-5 flex flex-col items-center">
            <span className="font-bold font-mono text-4xl text-white tabular-nums tracking-[-0.02em]">
              {`${ratio.toFixed(1)}:1`}
            </span>
            <span
              className={cn(
                "mt-1 font-mono text-[13px] uppercase tracking-[0.08em]",
                state === "good"
                  ? "text-good"
                  : state === "caution"
                    ? "text-caution"
                    : "text-accent",
              )}
            >
              {ratio < 1 ? "stalled" : "running"}
            </span>
          </div>
        </CalcPanel>
      </div>

      <CalcPanel className="mt-6">
        <RippleChain nodes={nodes} />

        <div className="mt-5">
          <Verdict tone={state}>{label}</Verdict>
        </div>

        <StatGrid className="mt-5">
          <Stat
            k={<Term id="PAYBACK">Payback</Term>}
            n={`${payback.toFixed(1)} mo`}
            sub="months to recoup CAC"
            tone={payback > 24 ? "warn" : payback > 12 ? "caution" : "good"}
          />
          <Stat
            k="Headroom vs CAC"
            n={`${headroom >= 0 ? "+" : ""}${money(headroom)}`}
            sub="ceiling − actual CAC"
            tone={headroom < 0 ? "warn" : "good"}
          />
        </StatGrid>

        <MeansForYou tone={state}>
          A customer paying <Fig>{money(arpa)}</Fig> a month at <Fig>{gm}%</Fig>{" "}
          margin, churning at <Fig>{churn.toFixed(1)}%</Fig>, stays about{" "}
          <Fig>{life.toFixed(0)} months</Fig> and is worth{" "}
          <Fig tone="good">{money(ltv)}</Fig> in gross profit. You pay{" "}
          <Fig>{money(cac)}</Fig> to win them — a{" "}
          <Fig tone={state}>{ratio.toFixed(1)}:1</Fig> return. {meaning}
        </MeansForYou>

        <Play
          moves={[
            "Lift ARPA without new customers — annual plans, a higher tier, usage add-ons, or dropping a discount. The fastest LTV win there is.",
            "Cut the cost to deliver. Margin is the lever most teams never touch: cheaper infra, fewer manual support hours, leaner third-party APIs.",
            "Lower CAC with conversion work before cutting spend — a better landing page or onboarding drops CAC with zero extra budget.",
          ]}
          consider="the costs gross margin hides — card fees (~3%), refunds, and the support hours a cheap plan quietly eats? They belong in margin too."
        />

        <Hint>
          Halve churn from 4% to 2% and LTV roughly doubles — and your
          affordable-CAC ceiling with it. Retention is an acquisition budget.
        </Hint>

        <Explainer summary="What is this chain telling me?">
          <p>
            Read it left to right — each box is computed from the one before it.
            Your <b>churn</b> sets how long a customer stays (
            <code>1 ÷ churn</code> = lifetime). Lifetime sets <b>LTV</b>, the
            total gross profit one customer brings. Then <b>LTV ÷ CAC</b> gives
            the ratio: how many times over a customer repays what you spent to
            win them.
          </p>
          <p>
            The benchmark is <b>3:1</b>. Below <b>1:1</b> you lose money on
            every customer you acquire; above <b>5:1</b> you are being too
            cautious and leaving growth on the table. Your affordable CAC — the
            most you can pay per customer and still hit that 3:1 return — is
            just <code>LTV ÷ 3</code>.
          </p>
          <p>
            That is why the flywheel spins. Healthy economics mean each customer
            funds more than one replacement, so you can afford to win more
            customers, who fund still more growth. Below <b>1:1</b> it stalls:
            the machine takes out more than it puts in, so every turn leaves you
            with less.
          </p>
        </Explainer>

        <Explainer summary="What counts as 'cost' here — and what doesn't">
          <p>
            Gross margin here means revenue minus the{" "}
            <b>direct cost to deliver</b> what you sold: hosting and
            infrastructure, third-party APIs, payment-processing fees (often
            ~3%), and the support tied to serving a customer. Refunds and
            chargebacks belong here too.
          </p>
          <p>
            What it does <b>not</b> include is fixed overhead — salaries, rent,
            tools, the team building the product. Those are real but they are
            not per-customer, so they live in your <Term id="BURN">burn</Term>,
            not your unit economics. Keep them out of margin or every customer
            looks unprofitable.
          </p>
          <p>
            Want to be stricter? Use{" "}
            <Term id="CONTRIB">contribution margin</Term> — gross margin minus
            the <i>variable</i> cost of <i>selling</i> (the ad-to-sale fee, the
            onboarding hour). It is the most honest input to LTV: it counts
            everything that scales with one more customer and nothing that does
            not.
          </p>
        </Explainer>
      </CalcPanel>
    </Section>
  );
}
