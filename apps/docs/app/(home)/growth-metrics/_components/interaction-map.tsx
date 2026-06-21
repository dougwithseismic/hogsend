"use client";

import type { JSX } from "react";
import { Card } from "@/components/ds/card";
import { Section, SectionHeading } from "@/components/ds/section";
import { Explainer, SectionIntro } from "./calc-kit";

/* -------------------------------------------------------------------------- */
/*  Lookup table — "if this moves, watch that".                                */
/* -------------------------------------------------------------------------- */

const LOOKUP: [string, string][] = [
  ["Churn ↓", "LTV ↑, LTV:CAC ↑, NRR ↑, affordable-CAC ceiling ↑"],
  ["Activation ↑", "retention ↑, referral ↑, LTV ↑ (all at once)"],
  ["ARPA ↑", "LTV ↑, payback ↓, CAC ceiling ↑"],
  ["K-factor ↑", "effective CAC ↓, blended CAC ↓"],
  [
    "Paid spend ↑ (no other change)",
    "blended CAC ↑, marginal CAC ↑, payback ↑",
  ],
  ["Conversion rate ↑", "CPL ↓, CAC ↓ (free efficiency, no extra spend)"],
];

/* -------------------------------------------------------------------------- */
/*  Load-bearing ideas.                                                        */
/* -------------------------------------------------------------------------- */

const IDEAS: [string, string][] = [
  [
    "Retention sets your acquisition budget",
    "Churn is the denominator of LTV, and LTV ÷ 3 is roughly what you can afford per customer. A retention win is an acquisition win one step removed.",
  ],
  [
    "Blended flatters, marginal decides",
    "Blended CAC hides paid behind organic. Scale spend and blended drifts up to meet paid while marginal CAC rises from saturation — they fire together.",
  ],
  [
    "Activation cascades",
    "Activated users retain; retained users refer; referrals lower CAC. Activation sits upstream of all three, so one fix moves everything.",
  ],
  [
    "LTV:CAC and payback are different questions",
    "LTV:CAC asks does the model work; payback asks how fast the cash comes back. Annual prepay fixes payback without touching LTV:CAC.",
  ],
];

/**
 * Synthesis section — the "if this moves, watch that" lookup table plus the
 * four load-bearing relationships. Reference, not a calculator.
 */
export function InteractionMap(): JSX.Element {
  return (
    <Section id="interaction-map">
      <SectionHeading
        eyebrow="How it all connects"
        title="No metric lives alone"
        subtitle="Every number here pulls on the others — lower churn lifts LTV, which lifts your affordable CAC, which lifts growth. Improve one upstream metric and the effect cascades."
      />

      <SectionIntro>
        <p>
          By now a pattern should be clear: every number you have moved pulls on
          the others. Churn changed your LTV; LTV changed your affordable CAC;
          activation quietly sat upstream of nearly everything. The table below
          is the cheat sheet — read each row as “improve the left, and the right
          moves with it” — and the four cards under it are the relationships
          worth committing to memory.
        </p>
      </SectionIntro>

      <div className="mt-10 flex flex-col gap-10">
        {/* Lookup table. */}
        <div className="flex flex-col gap-4">
          <h3 className="font-display text-[20px] text-white leading-[1.2] tracking-[-0.02em]">
            If this moves, watch that
          </h3>
          <div className="overflow-x-auto rounded-xl border border-white/[0.08] bg-white/[0.02]">
            <table className="w-full min-w-[520px] border-collapse text-left">
              <thead>
                <tr className="border-white/[0.08] border-b">
                  <th className="px-4 py-3 text-[10.5px] text-white/50 uppercase tracking-[0.07em]">
                    If this improves…
                  </th>
                  <th className="px-4 py-3 text-[10.5px] text-white/50 uppercase tracking-[0.07em]">
                    …these move with it
                  </th>
                </tr>
              </thead>
              <tbody>
                {LOOKUP.map(([cause, effect]) => (
                  <tr
                    key={cause}
                    className="border-white/[0.06] border-b last:border-b-0"
                  >
                    <th
                      scope="row"
                      className="whitespace-nowrap px-4 py-3 text-left align-top font-medium font-mono text-[13px] text-accent tabular-nums"
                    >
                      {cause}
                    </th>
                    <td className="px-4 py-3 align-top text-[13px] text-white/70 leading-6">
                      {effect}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Load-bearing ideas. */}
        <div className="grid gap-4 sm:grid-cols-2">
          {IDEAS.map(([title, body]) => (
            <Card key={title} className="flex flex-col gap-2.5">
              <h3 className="font-medium font-sans text-[17px] text-white leading-[1.3] tracking-[-0.01em]">
                {title}
              </h3>
              <p className="text-sm text-white/70 leading-6">{body}</p>
            </Card>
          ))}
        </div>

        <Explainer summary="The whole chain in one breath">
          <p>
            Activation (users reaching value) lifts retention, referral and LTV
            at once — fix it first. Lower churn and higher ARPA both push LTV
            up. Higher LTV raises your LTV:CAC, which raises your affordable
            CAC, which lets you buy more growth. Referral feeds growth directly
            and for free. Pull any one lever and the whole chain shifts — which
            is the entire point of the calculators above.
          </p>
        </Explainer>
      </div>
    </Section>
  );
}
