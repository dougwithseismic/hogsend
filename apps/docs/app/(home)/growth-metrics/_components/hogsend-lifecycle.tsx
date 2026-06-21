"use client";

import Link from "next/link";
import type { JSX } from "react";
import { Button } from "@/components/ds/button";
import { Card } from "@/components/ds/card";
import { Section, SectionHeading } from "@/components/ds/section";
import { AnalyticsEvent, capture } from "@/lib/analytics";
import { cn } from "@/lib/cn";
import {
  CalcNote,
  CalcPanel,
  Explainer,
  Fig,
  fmtNum,
  fmtPct,
  Hint,
  MeansForYou,
  NumberField,
  NumberRow,
  SectionIntro,
  Slider,
  Stat,
  StatGrid,
  Term,
  type Tone,
  toneText,
  useCurrency,
  useMoney,
} from "./calc-kit";
import { useGrowth } from "./growth-store";

/* -------------------------------------------------------------------------- */
/*  Part A — lever → journey mapping                                          */
/* -------------------------------------------------------------------------- */

type Lever = {
  lever: string;
  tone: Tone;
  title: string;
  body: string;
  href: string;
  link: string;
};

const LEVERS: Lever[] = [
  {
    lever: "Activation ↑",
    tone: "good",
    title: "Onboarding that waits for the aha",
    body: "A durable journey waits for the activation event, up to N days, then branches: nudge the stalled, advance the active.",
    href: "/use-cases/onboarding",
    link: "See the onboarding use case",
  },
  {
    lever: "Churn ↓",
    tone: "good",
    title: "Win-back that knows when someone left",
    body: "Spot the drop in product events and reach out before the renewal, not after.",
    href: "/use-cases/winback",
    link: "See win-back",
  },
  {
    lever: "Churn ↓",
    tone: "good",
    title: "Failed-payment dunning",
    body: "Reminders that sound human and stop the moment payment clears.",
    href: "/recipes/category/conversion",
    link: "See dunning recipes",
  },
  {
    lever: "NRR ↑",
    tone: "good",
    title: "Expansion & usage-limit nudges",
    body: "Catch accounts hitting a limit and offer the upgrade in-moment.",
    href: "/recipes/category/conversion",
    link: "See conversion recipes",
  },
  {
    lever: "Referral ↑",
    tone: "good",
    title: "Referral & share prompts",
    body: "Ask at the peak of delivered value, where the K-factor actually lives.",
    href: "/recipes",
    link: "Browse recipes",
  },
  {
    lever: "Retention ↑",
    tone: "good",
    title: "Digests, anniversaries, NPS",
    body: "Recurring touches that keep cohorts warm and surface who is slipping.",
    href: "/recipes/category/retention",
    link: "See retention recipes",
  },
];

function LeverCard({ item }: { item: Lever }): JSX.Element {
  return (
    <Card className="flex flex-col">
      <span className={cn("font-mono text-sm", toneText(item.tone))}>
        {item.lever === "NRR ↑" ? (
          <>
            <Term id="NRR">NRR</Term> ↑
          </>
        ) : (
          item.lever
        )}
      </span>
      <h3 className="mt-3 font-medium font-sans text-[17px] text-white leading-snug tracking-[-0.01em]">
        {item.title}
      </h3>
      <p className="mt-2 flex-1 text-sm text-white/60 leading-6">{item.body}</p>
      <Link
        href={item.href}
        className="mt-4 font-mono text-[13px] text-white/60 transition-colors hover:text-white"
      >
        {item.link} →
      </Link>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/*  Part B — lifecycle touch calculator                                       */
/* -------------------------------------------------------------------------- */

function commit(): void {
  capture(AnalyticsEvent.CALCULATOR_USED, { calculator: "lifecycle-touch" });
}

export function HogsendLifecycle(): JSX.Element {
  const money = useMoney();
  const { symbol } = useCurrency();
  const { inputs, setField } = useGrowth();

  const churnBefore = inputs.lcBaseChurn / 100;
  const churnAfter = Math.max((inputs.lcBaseChurn - inputs.lcCut) / 100, 0.001);
  const g = inputs.lcGm / 100;
  const ltvBefore = (inputs.lcArpa * g) / churnBefore;
  const ltvAfter = (inputs.lcArpa * g) / churnAfter;
  const incrementalActivations = inputs.lcNewUsers * (inputs.lcLift / 100);
  const activatedAfter =
    inputs.lcNewUsers * Math.min((inputs.lcBaseAct + inputs.lcLift) / 100, 1);
  const valueFromActivations = incrementalActivations * ltvAfter;
  const valueFromChurn = activatedAfter * (ltvAfter - ltvBefore);
  const monthlyUplift = valueFromActivations + valueFromChurn;
  const annualValue = monthlyUplift * 12;

  return (
    <Section id="hogsend-lifecycle">
      <SectionHeading
        eyebrow="Step 7 · Ship the lifecycle"
        title="Every metric here has a lifecycle lever"
        subtitle="The numbers move when you send the right message at the right moment. In Hogsend each lever is one durable TypeScript journey in your repo, triggered by your PostHog events — reviewed in a PR, not clicked together in a dashboard."
      />

      <SectionIntro>
        <p>
          Every lever on this page is, in the end, a message sent at the right
          moment — a nudge when someone stalls, a check-in before they churn, an
          ask when they are delighted. That is what a lifecycle program is, and
          it is exactly what Hogsend runs. Below, each lever maps to a journey
          that ships in the scaffold; then a calculator puts a number on what
          the whole program is worth, using your figures from the top.
        </p>
      </SectionIntro>

      <div className="mt-10">
        {/* Part A — lever → journey mapping */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {LEVERS.map((item) => (
            <LeverCard key={item.title} item={item} />
          ))}
        </div>

        {/* Part B — lifecycle touch calculator */}
        <CalcPanel className="mt-12">
          <CalcNote>
            A lifecycle program is worth the activations it adds plus the{" "}
            <Term id="CHURN">churn</Term> it removes. Plug in your funnel; the
            value flows straight through the same <Term id="LTV">LTV</Term>{" "}
            maths as above.
          </CalcNote>

          <div className="mt-6 grid gap-x-10 gap-y-6 lg:grid-cols-2">
            {/* Inputs */}
            <div>
              <span className="mb-3 inline-block rounded-md border border-white/[0.08] bg-white/[0.03] px-2.5 py-1 font-mono text-[11px] text-white/45">
                ↑ new users, churn, ARPA & margin seeded from your Start-here
                numbers
              </span>

              <NumberRow className="mb-4">
                <NumberField
                  label="Monthly new users"
                  value={inputs.lcNewUsers}
                  min={0}
                  step={50}
                  onChange={(v) => {
                    setField("lcNewUsers", v);
                    commit();
                  }}
                />
              </NumberRow>

              <Slider
                label="Baseline activation rate"
                min={5}
                max={90}
                step={1}
                value={inputs.lcBaseAct}
                onChange={(v) => setField("lcBaseAct", v)}
                onCommit={commit}
                display={fmtPct(inputs.lcBaseAct)}
              />
              <Slider
                label="Activation lift from onboarding (pp)"
                min={0}
                max={25}
                step={1}
                value={inputs.lcLift}
                onChange={(v) => setField("lcLift", v)}
                onCommit={commit}
                display={`+${inputs.lcLift} pp`}
              />
              <Slider
                label="Baseline monthly churn"
                labelNode={
                  <>
                    Baseline monthly <Term id="CHURN">churn</Term>
                  </>
                }
                min={0.5}
                max={12}
                step={0.1}
                value={inputs.lcBaseChurn}
                onChange={(v) => setField("lcBaseChurn", v)}
                onCommit={commit}
                display={`${inputs.lcBaseChurn.toFixed(1)}%`}
              />
              <Slider
                label="Churn cut from lifecycle (pp)"
                labelNode={
                  <>
                    <Term id="CHURN">Churn</Term> cut from lifecycle (pp)
                  </>
                }
                min={0}
                max={4}
                step={0.1}
                value={inputs.lcCut}
                onChange={(v) => setField("lcCut", v)}
                onCommit={commit}
                display={`−${inputs.lcCut.toFixed(1)} pp`}
              />

              <NumberRow className="mt-4">
                <NumberField
                  label="ARPA / mo"
                  value={inputs.lcArpa}
                  min={0}
                  step={5}
                  prefix={symbol}
                  onChange={(v) => {
                    setField("lcArpa", v);
                    commit();
                  }}
                />
                <NumberField
                  label="Gross margin %"
                  value={inputs.lcGm}
                  min={0}
                  step={1}
                  suffix="%"
                  onChange={(v) => {
                    setField("lcGm", v);
                    commit();
                  }}
                />
              </NumberRow>
            </div>

            {/* Readouts */}
            <div>
              <StatGrid>
                <Stat
                  k="Extra activations / mo"
                  n={fmtNum(incrementalActivations)}
                  tone="good"
                />
                <Stat
                  k="LTV per customer"
                  n={money(ltvAfter)}
                  sub={`was ${money(ltvBefore)}`}
                />
                <Stat
                  k="Monthly LTV uplift"
                  n={money(monthlyUplift)}
                  tone="good"
                />
                <Stat
                  k="Annual value created"
                  n={money(annualValue)}
                  tone="good"
                  className="col-span-full"
                />
              </StatGrid>

              <Hint>
                These touches are emails. Hogsend sends them from durable
                journeys with no per-contact billing, so widening lifecycle
                coverage does not widen the bill — your database just gets more
                rows.
              </Hint>

              <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-3">
                <Button href="/use-cases/onboarding" icon>
                  See the journeys
                </Button>
                <Button href="/pricing" variant="outline">
                  How pricing works
                </Button>
              </div>
            </div>
          </div>

          <MeansForYou tone="good">
            With <Fig>{fmtNum(inputs.lcNewUsers)}</Fig> new users a month,
            lifting activation <Fig tone="good">+{inputs.lcLift} points</Fig>{" "}
            turns roughly{" "}
            <Fig tone="good">{fmtNum(incrementalActivations)}</Fig> more of them
            into customers, each worth <Fig>{money(ltvAfter)}</Fig>. Trimming
            churn <Fig>−{inputs.lcCut.toFixed(1)} points</Fig> also lifts the
            value of everyone you keep, from <Fig>{money(ltvBefore)}</Fig> to{" "}
            <Fig>{money(ltvAfter)}</Fig>. Together that is{" "}
            <Fig tone="good">{money(monthlyUplift)}</Fig> a month — about{" "}
            <Fig tone="good">{money(annualValue)}</Fig> a year — from sending
            the right emails at the right moment.
          </MeansForYou>

          <Explainer summary="How is this number worth that much?">
            <p>
              A lifecycle program is worth two things. First, the extra
              customers it activates — the <b>incremental activations</b> it
              adds, each worth their <Term id="LTV">LTV</Term>. Second, the{" "}
              <Term id="CHURN">churn</Term> it removes — and because churn sits
              in the denominator of <code>LTV = ARPA × margin ÷ churn</code>,
              cutting it lifts the lifetime value of <b>everyone you keep</b>,
              not just the new ones. The calculator adds both pieces together
              and annualises the result.
            </p>
            <p>
              These touches are just emails, sent at the right moment. In
              Hogsend each one is a durable TypeScript journey triggered by your
              product events — reviewed in a PR, with{" "}
              <b>no per-contact billing</b>. So widening your coverage (more
              touches, more cohorts, better <Term id="NRR">NRR</Term>)
              doesn&apos;t widen the bill; your database just gets more rows.
            </p>
          </Explainer>
        </CalcPanel>
      </div>
    </Section>
  );
}
