"use client";

import type { JSX } from "react";
import { Section, SectionHeading } from "@/components/ds/section";
import { AnalyticsEvent, capture } from "@/lib/analytics";
import {
  CalcNote,
  CalcPanel,
  Explainer,
  Fig,
  Hint,
  MeansForYou,
  NumberField,
  NumberRow,
  Play,
  SectionIntro,
  Stat,
  Term,
  type Tone,
  useCurrency,
} from "./calc-kit";
import { useGrowth } from "./growth-store";

/* ========================================================================== */
/*  Efficiency — the whole-machine roll-ups a board reads in one glance:       */
/*  the magic number (is sales-and-marketing paying off), the rule of 40 (is   */
/*  the growth-versus-profit trade healthy), and the burn multiple (how much   */
/*  cash each dollar of new ARR costs).                                        */
/* ========================================================================== */

const onUse = (): void =>
  capture(AnalyticsEvent.CALCULATOR_USED, { calculator: "efficiency" });

export function Efficiency(): JSX.Element {
  const { symbol } = useCurrency();
  const { inputs, setField } = useGrowth();

  // Block 1 — Magic number (nnARR + priorSM seeded from the intake).
  const nnARR = inputs.nnARR;
  const priorSM = inputs.priorSM;

  // Block 2 — Rule of 40 (example knobs to swap).
  const grw = inputs.grw;
  const mgn = inputs.mgn;

  // Block 3 — Burn multiple.
  const burn = inputs.burn;
  const arr = inputs.burnARR;

  const magic = nnARR / Math.max(priorSM, 1e-9);
  const magicTone: Tone =
    magic >= 0.75 ? "good" : magic >= 0.5 ? "caution" : "warn";
  const magicSub =
    magic >= 0.75
      ? "step on the gas"
      : magic >= 0.5
        ? "acceptable"
        : "fix efficiency first";

  const r40 = grw + mgn;
  const r40Tone: Tone = r40 >= 40 ? "good" : r40 >= 25 ? "caution" : "warn";
  const r40Sub =
    r40 >= 40
      ? "clears 40 ✓"
      : "below 40 — trade margin for growth or vice-versa";

  const bm = burn / Math.max(arr, 1e-9);
  const bmTone: Tone = bm < 1 ? "good" : bm < 3 ? "caution" : "warn";
  const bmSub =
    bm < 1
      ? "excellent"
      : bm < 2
        ? "fine"
        : bm < 3
          ? "watch it"
          : "inefficient";

  const tones: Tone[] = [magicTone, r40Tone, bmTone];
  const worst: Tone = tones.includes("warn")
    ? "warn"
    : tones.includes("caution")
      ? "caution"
      : "good";

  return (
    <Section id="efficiency">
      <SectionHeading
        eyebrow="Step 6 · The whole machine"
        title="The roll-ups that decide whether to step on the gas"
        subtitle="Three numbers a board reads in one glance: is sales-and-marketing paying off, is the growth-versus-profit trade healthy, and how much cash each dollar of new ARR costs."
      />

      <SectionIntro>
        <p>
          Zoom out from any single metric and a board asks three blunter
          questions. Is the money you put into sales and marketing coming back?
          Are you growing fast enough to justify the losses — or profitable
          enough to forgive slow growth? And how much cash does each new pound
          of recurring revenue actually cost? These three roll-ups answer all
          three at a glance.
        </p>
      </SectionIntro>

      <CalcNote className="mt-4">
        The <Term id="MAGIC">magic-number</Term> inputs are seeded from your
        Start-here numbers; the growth and margin figures are an example to swap
        for your own.
      </CalcNote>

      <div className="mt-12">
        <CalcPanel>
          <div className="grid gap-6 grid-cols-[repeat(auto-fit,minmax(220px,1fr))]">
            {/* Block 1 — Magic number. */}
            <div className="flex flex-col gap-3">
              <CalcNote>
                Net new <Term id="ARR">ARR</Term> this quarter over the prior
                quarter&apos;s <Term id="SM">sales &amp; marketing</Term> spend.
              </CalcNote>
              <NumberRow>
                <NumberField
                  label="Net new ARR (qtr)"
                  value={nnARR}
                  onChange={(v) => {
                    setField("nnARR", v);
                    onUse();
                  }}
                  min={0}
                  step={50_000}
                  prefix={symbol}
                />
                <NumberField
                  label="Prior S&M"
                  value={priorSM}
                  onChange={(v) => {
                    setField("priorSM", v);
                    onUse();
                  }}
                  min={0}
                  step={50_000}
                  prefix={symbol}
                />
              </NumberRow>
              <Stat
                k={<Term id="MAGIC">Magic number</Term>}
                n={magic.toFixed(2)}
                sub={magicSub}
                tone={magicTone}
              />
            </div>

            {/* Block 2 — Rule of 40. */}
            <div className="flex flex-col gap-3">
              <CalcNote>
                Year-on-year growth rate plus profit margin. The sum should
                clear 40 — the <Term id="R40">Rule of 40</Term>.
              </CalcNote>
              <NumberRow>
                <NumberField
                  label="Growth %"
                  value={grw}
                  onChange={(v) => {
                    setField("grw", v);
                    onUse();
                  }}
                  step={5}
                  suffix="%"
                />
                <NumberField
                  label="Margin %"
                  value={mgn}
                  onChange={(v) => {
                    setField("mgn", v);
                    onUse();
                  }}
                  step={5}
                  suffix="%"
                />
              </NumberRow>
              <Stat k="Sum" n={r40.toFixed(0)} sub={r40Sub} tone={r40Tone} />
            </div>

            {/* Block 3 — Burn multiple. */}
            <div className="flex flex-col gap-3">
              <CalcNote>
                Net cash burned over net new ARR — the{" "}
                <Term id="BURN">burn multiple</Term>, how much you spend to buy
                a dollar of recurring revenue.
              </CalcNote>
              <NumberRow>
                <NumberField
                  label="Net burn"
                  value={burn}
                  onChange={(v) => {
                    setField("burn", v);
                    onUse();
                  }}
                  min={0}
                  step={50_000}
                  prefix={symbol}
                />
                <NumberField
                  label="Net new ARR"
                  value={arr}
                  onChange={(v) => {
                    setField("burnARR", v);
                    onUse();
                  }}
                  min={0}
                  step={50_000}
                  prefix={symbol}
                />
              </NumberRow>
              <Stat
                k={<Term id="BURN">Burn multiple</Term>}
                n={bm.toFixed(2)}
                sub={bmSub}
                tone={bmTone}
              />
            </div>
          </div>
        </CalcPanel>

        <MeansForYou tone={worst}>
          A magic number of <Fig tone={magicTone}>{magic.toFixed(2)}</Fig> says
          every <Fig>{symbol}1</Fig> of sales and marketing brings{" "}
          <Fig>{`${symbol}${magic.toFixed(2)}`}</Fig> of new ARR — {magicSub}.
          Your growth and margin sum to{" "}
          <Fig tone={r40Tone}>{r40.toFixed(0)}</Fig>,{" "}
          {r40 >= 40 ? "clearing the Rule of 40" : "short of the Rule of 40"}.
          And at a burn multiple of <Fig tone={bmTone}>{bm.toFixed(2)}</Fig> you
          spend <Fig>{`${symbol}${bm.toFixed(2)}`}</Fig> to add{" "}
          <Fig>{symbol}1</Fig> of recurring revenue — {bmSub}.
        </MeansForYou>

        <Play
          moves={[
            "If the magic number is below 0.75, fix conversion and retention before adding sales-and-marketing spend — otherwise you just burn faster.",
            "Hold the Rule of 40 deliberately: choose to trade growth for margin (or back), don't drift into a bad mix.",
            "Track the burn multiple monthly. A rising multiple means each new pound of ARR is getting more expensive — catch it early.",
          ]}
          consider="whether your growth is efficient or just expensive? These roll-ups are exactly what catch the difference vanity metrics hide."
        />

        <Hint>
          ARPA is the monetization term underneath all three — lift it and every
          roll-up improves at once.
        </Hint>

        <Explainer summary="When would I actually use these three?">
          <p>
            The <b>magic number</b> answers one question: is more sales spend
            worth it? It is the new annual revenue you earn per pound of{" "}
            <Term id="MAGIC">sales &amp; marketing</Term>. Above{" "}
            <code>0.75</code> you can pour money in with confidence; below{" "}
            <code>0.5</code> you should fix your efficiency before spending
            more.
          </p>
          <p>
            The{" "}
            <b>
              <Term id="R40">Rule of 40</Term>
            </b>{" "}
            is the trade-off referee: your growth percentage plus your
            profit-margin percentage should clear <code>40</code>. You can spend
            hard on growth or bank the margin instead — either is fine as long
            as the two added together still hold the line.
          </p>
          <p>
            The{" "}
            <b>
              <Term id="BURN">burn multiple</Term>
            </b>{" "}
            is the bluntest of the three: the cash you torch per pound of new
            recurring revenue. Under <code>1</code> is excellent; over{" "}
            <code>3</code> means you are leaking. Think of these as the
            dashboard lights — your <Term id="CAC">CAC</Term>,{" "}
            <Term id="CHURN">churn</Term> and <Term id="LTV">LTV</Term> are the
            parts under the bonnet.
          </p>
        </Explainer>
      </div>
    </Section>
  );
}
