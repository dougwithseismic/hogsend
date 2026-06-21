"use client";

import type { JSX, ReactNode } from "react";
import { Section, SectionHeading } from "@/components/ds/section";
import { AnalyticsEvent, capture } from "@/lib/analytics";
import {
  CalcPanel,
  Explainer,
  Fig,
  MeansForYou,
  SectionIntro,
  Term,
  useCurrency,
  useMoney,
} from "./calc-kit";
import { PRESETS, type PresetId, type RawKey, useGrowth } from "./growth-store";

const CALCULATOR_ID = "intake";

/** Ordered playbook — highest-leverage step first; anchors to each section. */
const ROADMAP: { step: string; href: string; title: string; note: string }[] = [
  {
    step: "Frame",
    href: "#master-frame",
    title: "Growth is multiplicative",
    note: "why the order matters",
  },
  {
    step: "Step 1",
    href: "#measure",
    title: "Measure it",
    note: "set up tracking first",
  },
  {
    step: "Step 2",
    href: "#unit-economics",
    title: "The engine room",
    note: "does each customer pay off?",
  },
  {
    step: "Step 3",
    href: "#retention-virality",
    title: "Keep them first",
    note: "the highest-leverage fix",
  },
  {
    step: "Step 4",
    href: "#growth-loop",
    title: "Make it loop",
    note: "free, compounding growth",
  },
  {
    step: "Step 5",
    href: "#blended-cac",
    title: "Buy honestly",
    note: "blended vs paid CAC",
  },
  {
    step: "Step 6",
    href: "#efficiency",
    title: "The whole machine",
    note: "the board's roll-ups",
  },
  {
    step: "Step 7",
    href: "#hogsend-lifecycle",
    title: "Ship the lifecycle",
    note: "turn levers into journeys",
  },
];

function commit(): void {
  capture(AnalyticsEvent.CALCULATOR_USED, { calculator: CALCULATOR_ID });
}

type Question = {
  key: RawKey;
  ask: string;
  why: ReactNode;
  prefix?: string;
  suffix: string;
  value: number;
};

/**
 * Inline numeric field with optional prefix/suffix. We build it by hand rather
 * than reusing the kit NumberField so the ask/why/field stack stays clean —
 * the visible label is the styled ask above it, and the input carries an
 * `aria-label` for its accessible name.
 */
function IntakeField({
  ask,
  value,
  onChange,
  prefix,
  suffix,
}: {
  ask: string;
  value: number;
  onChange: (value: number) => void;
  prefix?: string;
  suffix: string;
}): JSX.Element {
  return (
    <div className="flex items-center rounded-lg border border-white/[0.08] bg-white/[0.03] focus-within:border-accent/60">
      {prefix ? (
        <span className="pl-3 font-mono text-sm text-white/40">{prefix}</span>
      ) : null}
      <input
        type="number"
        inputMode="decimal"
        min={0}
        aria-label={ask}
        value={Number.isFinite(value) ? value : ""}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
        className="w-full bg-transparent px-3 py-2.5 font-mono text-[15px] text-white tabular-nums outline-none"
      />
      <span className="pr-3 font-mono text-sm text-white/40">{suffix}</span>
    </div>
  );
}

/**
 * "Start here" onboarding — six plain-English questions the visitor already
 * knows the answers to. The store derives ARPA, CAC, churn and lifetime from
 * them and seeds every calculator below, so nobody has to know the jargon to
 * begin. Presets seed sensible starting points; editing any answer re-derives
 * the chips and re-seeds downstream. Fires `docs.calculator_used` on change.
 */
export function Intake(): JSX.Element {
  const { inputs, derived, setIntake, loadPreset } = useGrowth();
  const money = useMoney();
  const { symbol } = useCurrency();

  const roughLtv =
    (derived.arpa * (inputs.gm / 100)) / (derived.churnPct / 100);

  const onChange = (key: RawKey) => (value: number) => {
    setIntake(key, value);
    commit();
  };

  const questions: Question[] = [
    {
      key: "rev",
      ask: "How much revenue do you bring in per month?",
      why: "Total across all customers. If you bill yearly, divide by 12.",
      prefix: symbol,
      suffix: "/mo",
      value: inputs.rev,
    },
    {
      key: "cust",
      ask: "How many paying customers is that?",
      why: (
        <>
          We divide the two to get your <Term id="ARPA">ARPA</Term> — average
          revenue per customer.
        </>
      ),
      suffix: "customers",
      value: inputs.cust,
    },
    {
      key: "spend",
      ask: "How much do you spend winning customers, per month?",
      why: (
        <>
          Ads, content, sales — the cost of growth. Powers your{" "}
          <Term id="CAC">CAC</Term>.
        </>
      ),
      prefix: symbol,
      suffix: "/mo",
      value: inputs.spend,
    },
    {
      key: "newCust",
      ask: "How many new customers did that bring last month?",
      why: "Spend ÷ new customers = what each one cost to acquire.",
      suffix: "new",
      value: inputs.newCust,
    },
    {
      key: "lost",
      ask: "Roughly how many customers do you lose each month?",
      why: (
        <>
          This is <Term id="CHURN">churn</Term>. For most subscription
          businesses it's 3–7% of the base.
        </>
      ),
      suffix: "lost/mo",
      value: inputs.lost,
    },
    {
      key: "gm",
      ask: "What's your gross margin?",
      why: (
        <>
          <Term id="GM">Gross margin</Term> = what's left after the cost to
          deliver. Software ≈ 80%, services ≈ 40%, physical ≈ 30%.
        </>
      ),
      suffix: "%",
      value: inputs.gm,
    },
  ];

  const chips: { label: ReactNode; value: string; sub: string }[] = [
    {
      label: <Term id="ARPA">ARPA</Term>,
      value: `${money(derived.arpa)} /mo`,
      sub: "rev ÷ customers",
    },
    {
      label: <Term id="CAC">CAC</Term>,
      value: money(derived.cac),
      sub: "spend ÷ new",
    },
    {
      label: <Term id="CHURN">Churn</Term>,
      value: `${derived.churnPct.toFixed(1)}% /mo`,
      sub: "lost ÷ base",
    },
    {
      label: <Term id="LIFETIME">Lifetime</Term>,
      value: `${derived.life.toFixed(0)} mo`,
      sub: "1 ÷ churn",
    },
  ];

  return (
    <Section id="start-here">
      <SectionHeading
        eyebrow="Start here"
        title="Begin with what you actually know"
        subtitle="No jargon required. Answer these six plain questions — the tool derives the rest and seeds every calculator below. Not sure of a number? Tap a starting point, then edit."
      />

      <SectionIntro>
        <p>
          Most explainers hand you a wall of definitions and leave you to work
          out what to do with them. This one runs the other way. Tell it a few
          things you already know about your business and it fills in the
          jargon, draws the relationships, and — in plain English under each
          section — tells you what the numbers mean <b>for you</b>. Nothing you
          type leaves your browser.
        </p>
      </SectionIntro>

      <div className="mt-8 flex flex-wrap gap-2.5">
        {(Object.entries(PRESETS) as [PresetId, { label: string }][]).map(
          ([id, { label }]) => (
            <button
              key={id}
              type="button"
              onClick={() => {
                loadPreset(id as PresetId);
                commit();
              }}
              className="rounded-full border border-white/15 px-3.5 py-2 font-mono text-white/70 text-xs transition-colors hover:border-accent hover:text-accent"
            >
              {label}
            </button>
          ),
        )}
      </div>

      <CalcPanel className="mt-6">
        <div className="grid gap-5 sm:grid-cols-2">
          {questions.map((q) => (
            <div key={q.key} className="flex flex-col gap-1.5">
              <div className="font-medium text-[15px] text-white">{q.ask}</div>
              <div className="text-white/45 text-xs leading-relaxed">
                {q.why}
              </div>
              <IntakeField
                ask={q.ask}
                value={q.value}
                onChange={onChange(q.key)}
                prefix={q.prefix}
                suffix={q.suffix}
              />
            </div>
          ))}
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 border-white/15 border-t border-dashed pt-4 sm:grid-cols-4">
          {chips.map((chip) => (
            <div
              key={chip.sub}
              className="rounded-xl border border-white/[0.08] bg-white/[0.03] p-3.5"
            >
              <div className="mb-1.5 text-[11px] text-white/55">
                {chip.label}
              </div>
              <div className="font-bold font-mono text-[20px] text-white tabular-nums tracking-[-0.02em]">
                {chip.value}
              </div>
              <div className="mt-1 font-mono text-[10.5px] text-white/40">
                {chip.sub}
              </div>
            </div>
          ))}
        </div>
      </CalcPanel>

      <MeansForYou>
        Those six answers already say a lot. Each customer pays you{" "}
        <Fig>{money(derived.arpa)}</Fig> a month, costs{" "}
        <Fig>{money(derived.cac)}</Fig> to win, and stays about{" "}
        <Fig>{derived.life.toFixed(0)} months</Fig> — so they are worth roughly{" "}
        <Fig tone="good">{money(roughLtv)}</Fig> in gross profit before they
        leave. Every calculator below starts from exactly that; change one
        answer and they all move.
      </MeansForYou>

      <div className="mt-10">
        <h3 className="mb-3 font-display text-[20px] text-white leading-[1.2] tracking-[-0.02em]">
          Your path from here
        </h3>
        <p className="mb-5 max-w-2xl text-sm text-white/55 leading-6">
          Work top to bottom — the sections are ordered by leverage, highest
          first. Measure, understand the engine, fix what leaks most, then buy
          growth and ship the lifecycle that holds it together.
        </p>
        <ol className="divide-y divide-white/[0.06] overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.02]">
          {ROADMAP.map((item) => (
            <li key={item.href}>
              <a
                href={item.href}
                className="flex items-baseline gap-4 px-4 py-3 transition-colors hover:bg-white/[0.03]"
              >
                <span className="w-14 shrink-0 font-mono text-[12px] text-accent">
                  {item.step}
                </span>
                <span className="font-medium text-[15px] text-white">
                  {item.title}
                </span>
                <span className="ml-auto hidden text-right text-[13px] text-white/50 sm:block">
                  {item.note}
                </span>
              </a>
            </li>
          ))}
        </ol>
      </div>

      <Explainer summary="Why start with these five and not the fancy metrics?">
        <p>
          Everything else on this page is <b>built from these answers</b>, not
          looked up somewhere separately. ARPA, CAC, lifetime value and payback
          aren't independent facts you have to go find — they're just arithmetic
          on the handful of numbers you already track. Get the basics in and the
          rest falls out.
        </p>
        <p>
          <code>ARPA = revenue ÷ customers</code>,{" "}
          <code>CAC = spend ÷ new customers</code>, and <code>churn</code> is
          simply who leaves each month. From those three the tool derives your
          lifetime value, your payback period, and the most you can afford to
          spend winning a customer.
        </p>
        <p>
          If a number is a guess, that's fine — start with a preset and edit.
          Drag the sliders below and you'll see that <b>churn and margin</b>{" "}
          move the needle far more than ARPA does, which is exactly the point:
          it tells you where the leverage actually is.
        </p>
      </Explainer>
    </Section>
  );
}
