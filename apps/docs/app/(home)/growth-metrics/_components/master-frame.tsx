"use client";

import { type JSX, useState } from "react";
import { TagPill } from "@/components/ds/badge";
import { Card } from "@/components/ds/card";
import { Section, SectionHeading } from "@/components/ds/section";
import { AnalyticsEvent, capture } from "@/lib/analytics";
import { cn } from "@/lib/cn";
import {
  Explainer,
  fmtMul,
  fmtPct,
  Hint,
  SectionIntro,
  Slider,
  Stat,
  StatGrid,
  type Tone,
} from "./calc-kit";

/* -------------------------------------------------------------------------- */
/*  Master frame — the five-factor growth equation, live.                     */
/* -------------------------------------------------------------------------- */

type Term = {
  /** Stable key for React lists. */
  id: string;
  /** Display name in the equation + bar label. */
  name: string;
  /** Current rate as a whole percent [0,100]. */
  value: number;
  /** Setter for the rate. */
  set: (value: number) => void;
};

/** Term value (fraction) we lift the binding constraint to in the readout. */
const FIX_TARGET = 0.8;

/**
 * MasterFrame — Growth = Acquisition × Activation × Retention × Monetization ×
 * Referral. Five rate sliders feed one product; the binding constraint is the
 * worst term, and fixing it multiplies everything downstream. Fires
 * `docs.calculator_used` (calculator: "master-frame") on slider release.
 */
export function MasterFrame(): JSX.Element {
  const [acquisition, setAcquisition] = useState(70);
  const [activation, setActivation] = useState(40);
  const [retention, setRetention] = useState(80);
  const [monetization, setMonetization] = useState(60);
  const [referral, setReferral] = useState(30);

  const terms: Term[] = [
    { id: "acq", name: "Acquisition", value: acquisition, set: setAcquisition },
    { id: "act", name: "Activation", value: activation, set: setActivation },
    { id: "ret", name: "Retention", value: retention, set: setRetention },
    {
      id: "mon",
      name: "Monetization",
      value: monetization,
      set: setMonetization,
    },
    { id: "ref", name: "Referral", value: referral, set: setReferral },
  ];

  // Product of the five rates, each as a fraction.
  const product = terms.reduce((acc, term) => acc * (term.value / 100), 1);

  // Binding constraint = the term with the minimum rate.
  const binding = terms.reduce((min, term) =>
    term.value < min.value ? term : min,
  );
  const bindingFraction = binding.value / 100;

  // Multiplier gained by raising ONLY the binding term to FIX_TARGET.
  const fixedProduct =
    bindingFraction > 0
      ? (product / bindingFraction) * FIX_TARGET
      : product * FIX_TARGET;
  const gain = product > 0 ? fixedProduct / product : Number.POSITIVE_INFINITY;

  const indexTone: Tone = product < 0.1 ? "caution" : "good";

  function commit(): void {
    capture(AnalyticsEvent.CALCULATOR_USED, { calculator: "master-frame" });
  }

  return (
    <Section id="master-frame">
      <SectionHeading
        eyebrow="The frame"
        title="Growth is multiplicative, not additive"
        subtitle="Every term below is a factor in one equation. Because they multiply, the binding constraint is whichever one is worst — a 0.4 anywhere caps the whole product."
      />

      <SectionIntro>
        <p>
          Step back from the individual calculators for a moment. Growth is one
          chain of five stages — a visitor has to get <b>acquired</b>, then{" "}
          <b>activate</b>, then <b>stick around</b>, then <b>pay</b>, and maybe{" "}
          <b>refer</b> a friend. Because each stage passes a fraction of people
          to the next, the outcomes multiply rather than add — which is why a
          single weak stage drags the whole result down, no matter how strong
          the others are. Move the sliders and watch which one is holding you
          back.
        </p>
      </SectionIntro>

      <div className="mt-10 flex flex-col gap-8">
        {/* The equation. */}
        <code className="block overflow-x-auto rounded-xl border border-white/[0.08] bg-white/[0.03] px-5 py-4 font-mono text-[13px] text-white/85 leading-6 sm:text-[15px]">
          <span className="text-white">Growth</span>
          <span className="text-white/40"> = </span>
          <span className="text-white/85">Acquisition</span>
          <span className="text-white/40"> × </span>
          <span className="text-white/85">Activation</span>
          <span className="text-white/40"> × </span>
          <span className="text-white/85">Retention</span>
          <span className="text-white/40"> × </span>
          <span className="text-white/85">Monetization</span>
          <span className="text-white/40"> × </span>
          <span className="text-white/85">Referral</span>
        </code>

        <div className="grid gap-8 lg:grid-cols-2">
          {/* Sliders. */}
          <div>
            {terms.map((term) => (
              <Slider
                key={term.id}
                label={`${term.name} rate`}
                value={term.value}
                min={0}
                max={100}
                step={1}
                onChange={term.set}
                onCommit={commit}
                display={fmtPct(term.value)}
              />
            ))}
          </div>

          {/* Bars. */}
          <div className="flex flex-col gap-3">
            {terms.map((term) => {
              const isBinding = term.id === binding.id;
              return (
                <div key={term.id}>
                  <div className="mb-1.5 flex items-baseline justify-between gap-3 text-[13px]">
                    <span className="flex items-center gap-2 text-white/60">
                      {term.name}
                      {isBinding ? (
                        <TagPill accent className="font-mono text-[10px]">
                          binding constraint
                        </TagPill>
                      ) : null}
                    </span>
                    <span
                      className={cn(
                        "font-mono text-[13px] tabular-nums",
                        isBinding ? "text-accent" : "text-white",
                      )}
                    >
                      {fmtPct(term.value)}
                    </span>
                  </div>
                  <div className="h-2.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
                    <div
                      className={cn(
                        "h-full rounded-full transition-all duration-300",
                        isBinding ? "bg-accent" : "bg-white/30",
                      )}
                      style={{ width: `${term.value}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Readout. */}
        <StatGrid>
          <Stat
            k="Growth index"
            n={product.toFixed(3)}
            sub="product of all five"
            tone={indexTone}
          />
          <Stat
            k="Binding constraint"
            n={binding.name}
            sub={fmtPct(binding.value)}
            tone="caution"
          />
          <Stat
            k="Fix it → 0.8"
            n={fmtMul(gain)}
            sub="raise the worst term only"
            tone="good"
          />
        </StatGrid>

        <Hint>
          Raising your worst term beats raising your best — fixing the leakiest
          stage multiplies everything downstream.
        </Hint>

        {/* Funnels vs loops callout. */}
        <Card className="rounded-xl">
          <h3 className="font-medium font-sans text-base text-white leading-6">
            Funnels leak, loops compound
          </h3>
          <p className="mt-2 max-w-3xl text-sm text-white/60 leading-6">
            A funnel is a one-way drop-off; a loop feeds its output back into
            its input — referrals make new users who refer; revenue buys ad
            spend that makes revenue. Channels that don&apos;t close a loop have
            a ceiling.
          </p>
        </Card>

        <Explainer summary="Why multiply, not add?">
          <p>
            The five stages are a chain, not a checklist. A visitor has to get
            acquired <b>and</b> activate <b>and</b> stick <b>and</b> pay{" "}
            <b>and</b> (maybe) refer — each stage only passes through what the
            one before it left behind. Because the outcomes stack on top of each
            other, they <b>multiply</b>; one weak stage caps the whole product
            no matter how strong the others are.
          </p>
          <p>
            That&apos;s why the maths rewards fixing your worst stage. Lifting a{" "}
            <code>0.2</code> to <code>0.4</code> doubles the product, while
            polishing a <code>0.8</code> to <code>0.9</code> barely moves it.
            Find the <b>floor</b>, not the ceiling.
          </p>
        </Explainer>
      </div>
    </Section>
  );
}
