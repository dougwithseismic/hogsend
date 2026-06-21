"use client";

/* ========================================================================== */
/*  Glossary — static reference cheatsheet for the growth-metrics explainer.   */
/*                                                                            */
/*  Five labelled groups of terms. Each row pairs the term (a hover/tap       */
/*  TermTooltip carrying the formula) with the "what it tells you" note.      */
/*  No money/currency state — pure reference. "use client" because the kit's  */
/*  TermTooltip is a client component.                                        */
/* ========================================================================== */

import type { JSX, ReactNode } from "react";
import { TagPill } from "@/components/ds/badge";
import { Section, SectionHeading } from "@/components/ds/section";
import { cn } from "@/lib/cn";
import { Formula, TermTooltip } from "./calc-kit";

type Row = {
  term: string;
  formula: ReactNode;
  definition: string;
  note: string;
};

type Group = {
  label: string;
  rows: Row[];
};

const GROUPS: Group[] = [
  {
    label: "Acquisition & cost",
    rows: [
      {
        term: "CAC",
        formula: <Formula>S&amp;M spend ÷ new customers</Formula>,
        definition: "Fully-loaded cost to acquire one customer.",
        note: "Fully-loaded means salaries, tools, overhead — not just media. The headline number people quote is media-only and flatters you.",
      },
      {
        term: "Blended CAC",
        formula: <Formula>total S&amp;M ÷ all new customers</Formula>,
        definition: "CAC across paid and organic together.",
        note: "Always ≤ paid CAC because free/organic customers dilute the denominator. Good for a board headline, dangerous for budgeting.",
      },
      {
        term: "Paid CAC",
        formula: <Formula>paid spend ÷ paid customers</Formula>,
        definition: "CAC for bought customers only.",
        note: "The real cost of a bought customer — the number that matters when deciding whether to scale a channel.",
      },
      {
        term: "Marginal CAC",
        formula: <Formula>Δspend ÷ Δcustomers</Formula>,
        definition: "Cost of the next customer acquired.",
        note: "Cost of the next customer. Rises with saturation. This, not average CAC, governs the should-I-add-budget decision.",
      },
      {
        term: "Conversion rate",
        formula: <Formula>conversions ÷ visitors</Formula>,
        definition: "Share of visitors who take the goal action.",
        note: "The multiplier that turns CPC into CPL into CAC. Improving it lowers CAC with zero extra spend.",
      },
    ],
  },
  {
    label: "Value & unit economics",
    rows: [
      {
        term: "LTV / CLV",
        formula: <Formula>ARPA × GM% ÷ churn</Formula>,
        definition: "Lifetime gross-margin value of a customer.",
        note: "Churn sits in the denominator, so LTV is hypersensitive to it. Always use gross-margin LTV, not revenue LTV, or you overpay for customers.",
      },
      {
        term: "Avg customer lifetime",
        formula: <Formula>1 ÷ churn</Formula>,
        definition: "Expected months a customer stays.",
        note: "5% monthly churn → a 20-month lifetime.",
      },
      {
        term: "LTV:CAC",
        formula: <Formula>LTV ÷ CAC</Formula>,
        definition: "Return on each acquired customer.",
        note: "~3:1 healthy · <1:1 lighting money on fire · >5:1 you are under-investing in growth.",
      },
      {
        term: "CAC payback",
        formula: <Formula>CAC ÷ (ARPA × GM%)</Formula>,
        definition: "Months to recoup acquisition cost.",
        note: "Months to recoup CAC — the cash-velocity question, separate from LTV:CAC. <12mo strong for SMB, 18–24mo tolerable for enterprise.",
      },
      {
        term: "Contribution margin",
        formula: <Formula>revenue − variable cost</Formula>,
        definition: "What each sale leaves after variable cost.",
        note: "The GM% feeding LTV. If this is thin, good LTV:CAC ratios are an illusion.",
      },
    ],
  },
  {
    label: "Retention & churn",
    rows: [
      {
        term: "Logo churn",
        formula: <Formula>customers lost ÷ starting customers</Formula>,
        definition: "Customers lost as a share of the base.",
        note: "Counts heads, ignores their size.",
      },
      {
        term: "GRR",
        formula: <Formula>(start − contraction − churn) ÷ start MRR</Formula>,
        definition: "Revenue kept before any expansion.",
        note: "Caps at 100%. The true leakage rate, no upsell masking. Best-in-class >90%.",
      },
      {
        term: "NRR / NDR",
        formula: (
          <Formula>
            (start + expansion − contraction − churn) ÷ start MRR
          </Formula>
        ),
        definition: "Revenue from existing customers over time.",
        note: "The single most important SaaS number. >100% = you grow even if you acquire nobody. Elite is 120%+.",
      },
      {
        term: "SaaS quick ratio",
        formula: <Formula>(new + expansion) ÷ (churned + contraction)</Formula>,
        definition: "Revenue added against revenue lost.",
        note: "Growth quality. >4 = efficient; ~1 = treading water.",
      },
      {
        term: "Cohort retention curve",
        formula: <Formula>% of a cohort still active over time</Formula>,
        definition: "How a signup cohort decays over time.",
        note: "A flattening curve = product-market fit; a curve that decays to zero means no amount of CAC will fix it.",
      },
    ],
  },
  {
    label: "Activation & engagement",
    rows: [
      {
        term: "North Star Metric",
        formula: <Formula>the one number that proxies delivered value</Formula>,
        definition: "The single metric the org optimises.",
        note: "Should sit where value-to-user meets revenue. Bad NSMs (signups, pageviews) drive the org off a cliff.",
      },
      {
        term: "Aha moment",
        formula: (
          <Formula>the action correlated with long-term retention</Formula>
        ),
        definition: "The action that predicts a user sticks.",
        note: "Add 7 friends in 10 days; send 1st invoice. Find it by comparing retained vs churned cohorts.",
      },
      {
        term: "Activation rate",
        formula: <Formula>% of new users who hit the aha</Formula>,
        definition: "Share of new users reaching first value.",
        note: "Upstream of everything — fixing it lifts retention, referral and LTV at once.",
      },
      {
        term: "DAU/MAU (stickiness)",
        formula: <Formula>DAU ÷ MAU</Formula>,
        definition: "How often monthly users come back.",
        note: ">20% decent, >50% exceptional for consumer/social.",
      },
      {
        term: "Vanity metrics",
        formula: <Formula>signups, impressions, downloads</Formula>,
        definition: "Totals that look good but predict nothing.",
        note: "Real only when tied to activation/retention. Treat raw totals as noise.",
      },
    ],
  },
  {
    label: "Growth loops & virality",
    rows: [
      {
        term: "K-factor",
        formula: <Formula>invites per user × invite conversion</Formula>,
        definition: "New users each user brings in.",
        note: "K>1 = self-sustaining exponential growth. K<1 still amplifies paid but decays without a feed.",
      },
      {
        term: "Viral amplification",
        formula: <Formula>1 ÷ (1 − K) for K&lt;1</Formula>,
        definition: "Multiplier paid acquisition gets from virality.",
        note: "K=0.5 → every paid cohort effectively doubles.",
      },
      {
        term: "Viral cycle time",
        formula: <Formula>time from joining to inviting</Formula>,
        definition: "How fast a viral loop turns over.",
        note: "Halving cycle time matters more than raising K — it is the exponent's clock speed.",
      },
      {
        term: "Growth loop",
        formula: <Formula>output re-enters as input</Formula>,
        definition: "A cycle where output feeds the next input.",
        note: "Paid, viral, content/SEO, sales. The compounding engine versus the leaky funnel.",
      },
    ],
  },
];

const RULES = [
  "LTV:CAC 3:1 target",
  "Payback <12mo SMB",
  "NRR >100% compounds · 120%+ elite",
  "GRR >90% sticky",
  "Quick ratio >4 efficient",
  "Magic number >0.75 step on the gas",
  "Rule of 40",
  "Burn multiple <1",
];

function GroupBlock({ group }: { group: Group }): JSX.Element {
  return (
    <div>
      <div className="mb-3 text-[10.5px] text-white/50 uppercase tracking-[0.07em]">
        {group.label}
      </div>
      <dl className="rounded-xl border border-white/[0.08] bg-white/[0.02]">
        {group.rows.map((row, index) => (
          <div
            key={row.term}
            className={cn(
              "grid gap-x-8 gap-y-1 px-4 py-3.5 md:grid-cols-[minmax(0,260px)_1fr]",
              index > 0 && "border-white/[0.06] border-t",
            )}
          >
            <dt className="text-[14px]">
              <TermTooltip
                term={row.term}
                formula={row.formula}
                definition={row.definition}
              />
            </dt>
            <dd className="text-sm text-white/70 leading-6">{row.note}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/**
 * Glossary — the static cheatsheet. Five labelled groups, each a bordered
 * definition list pairing the term (TermTooltip → formula) with the "what it
 * tells you" note, then a rules-of-thumb chip row. Pure reference, no state.
 */
export function Glossary(): JSX.Element {
  return (
    <Section id="glossary">
      <SectionHeading
        eyebrow="The cheatsheet"
        title="Definitions are the easy part"
        subtitle="The value is in the second column — what actually moves when this moves. Hover or tap any term for the formula."
      />

      <div className="mt-12 flex flex-col gap-10">
        {GROUPS.map((group) => (
          <GroupBlock key={group.label} group={group} />
        ))}

        <div>
          <div className="mb-3 text-[10.5px] text-white/50 uppercase tracking-[0.07em]">
            Rules of thumb
          </div>
          <div className="flex flex-wrap gap-2">
            {RULES.map((rule) => (
              <TagPill key={rule}>{rule}</TagPill>
            ))}
          </div>
        </div>
      </div>
    </Section>
  );
}
