"use client";

import type { JSX } from "react";
import { Section, SectionHeading } from "@/components/ds/section";
import { AnalyticsEvent, capture } from "@/lib/analytics";
import {
  CalcNote,
  CalcPanel,
  Explainer,
  Fig,
  fmtPct,
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
  useCurrency,
  useMoney,
} from "./calc-kit";
import { useGrowth } from "./growth-store";

/**
 * Retention & virality — two side-by-side calculators. Panel A turns the five
 * MRR movements (start, new, expansion, contraction, churned) into NRR / GRR /
 * quick ratio / net-new MRR. Panel B turns a viral loop (invites × conversion)
 * into a K-factor, amplification multiple, and the discounted effective CAC.
 * Both fire `docs.calculator_used` on commit, tagged by calculator id.
 */
export function RetentionVirality(): JSX.Element {
  const money = useMoney();
  const { symbol } = useCurrency();
  const { inputs, setField } = useGrowth();

  /* ---- Panel A: retention --------------------------------------------- */
  const start = inputs.sMRR;
  const newMrr = inputs.newMRR;
  const expansion = inputs.expMRR;
  const contraction = inputs.conMRR;
  const churned = inputs.chMRR;

  const s = start;
  const nrr = ((s + expansion - contraction - churned) / s) * 100;
  const grr = ((s - contraction - churned) / s) * 100;
  const qr = (newMrr + expansion) / Math.max(contraction + churned, 1e-9);
  const nn = newMrr + expansion - contraction - churned;
  const end = s + nn;

  const nrrTone: Tone = nrr >= 120 ? "good" : nrr >= 100 ? "caution" : "warn";
  const grrTone: Tone = grr >= 90 ? "good" : grr >= 80 ? "caution" : "warn";
  const qrTone: Tone = qr >= 4 ? "good" : qr >= 2 ? "caution" : "warn";
  const nnTone: Tone = nn >= 0 ? "good" : "warn";

  function commitRetention(): void {
    capture(AnalyticsEvent.CALCULATOR_USED, { calculator: "retention" });
  }

  /* ---- Panel B: virality ---------------------------------------------- */
  const invites = inputs.inv;
  const conv = inputs.conv;
  const cac = inputs.kCAC;

  const k = invites * (conv / 100);
  const viral = k >= 1;
  const mode = viral ? "exponential" : "amplifying";
  const amplification = viral ? "∞" : `${(1 / (1 - k)).toFixed(2)}×`;
  const effectiveCAC = viral ? money(0) : money(cac * (1 - k));
  const kTone: Tone = k >= 1 ? "good" : k >= 0.5 ? "caution" : "neutral";

  function commitVirality(): void {
    capture(AnalyticsEvent.CALCULATOR_USED, { calculator: "virality" });
  }

  return (
    <Section id="retention-virality">
      <SectionHeading
        eyebrow="Step 3 · Keep them first"
        title="Two ways to grow without buying it"
        subtitle="Net revenue retention compounds even if you acquire nobody. A viral loop injects free customers that cut your real CAC. Both move the same flywheel."
      />

      <SectionIntro>
        <p>
          Buying customers is only one way to grow, and the most expensive. The
          other two are keeping the ones you have and getting them to bring
          friends. <b>Net revenue retention</b> measures the first — whether
          your existing base expands faster than it leaks. <b>K-factor</b>{" "}
          measures the second — how far each customer multiplies into more. Both
          quietly lower the cost of everything else on this page.
        </p>
      </SectionIntro>

      <div className="mt-10 grid gap-6 md:grid-cols-2">
        {/* Panel A — Retention */}
        <CalcPanel>
          <span className="mb-3 inline-block rounded-md border border-white/[0.08] bg-white/[0.03] px-2.5 py-1 font-mono text-[11px] text-white/45">
            ↑ seeded from your Start-here numbers — edit freely
          </span>

          <CalcNote>
            <Term id="NRR">NRR</Term> above 100% means you grow with zero new
            logos. <Term id="GRR">GRR</Term> is the true leakage rate with no
            upsell masking. <Term id="QR">Quick ratio</Term> is growth quality:
            bookings versus the bleed.
          </CalcNote>

          <NumberRow className="mt-5">
            <NumberField
              label="Start MRR"
              value={start}
              onChange={(v) => {
                setField("sMRR", v);
                commitRetention();
              }}
              min={0}
              prefix={symbol}
            />
            <NumberField
              label="New"
              value={newMrr}
              onChange={(v) => {
                setField("newMRR", v);
                commitRetention();
              }}
              min={0}
              prefix={symbol}
            />
            <NumberField
              label="Expansion"
              value={expansion}
              onChange={(v) => {
                setField("expMRR", v);
                commitRetention();
              }}
              min={0}
              prefix={symbol}
            />
            <NumberField
              label="Contraction"
              value={contraction}
              onChange={(v) => {
                setField("conMRR", v);
                commitRetention();
              }}
              min={0}
              prefix={symbol}
            />
            <NumberField
              label="Churned"
              value={churned}
              onChange={(v) => {
                setField("chMRR", v);
                commitRetention();
              }}
              min={0}
              prefix={symbol}
            />
          </NumberRow>

          <StatGrid className="mt-6">
            <Stat
              k={<Term id="NRR">NRR</Term>}
              n={fmtPct(nrr)}
              tone={nrrTone}
              sub="120%+ = elite"
            />
            <Stat
              k={<Term id="GRR">GRR</Term>}
              n={fmtPct(grr)}
              tone={grrTone}
              sub=">90% = sticky"
            />
            <Stat
              k={<Term id="QR">Quick ratio</Term>}
              n={qr.toFixed(1)}
              tone={qrTone}
              sub=">4 = efficient"
            />
            <Stat
              k={<Term id="NETNEW">Net new MRR</Term>}
              n={`${nn >= 0 ? "+" : ""}${money(nn)}`}
              tone={nnTone}
              sub={`→ end ${money(end)}`}
            />
          </StatGrid>
        </CalcPanel>

        {/* Panel B — Virality */}
        <CalcPanel>
          <CalcNote>
            <Term id="KFAC">K-factor</Term> injects free customers, so effective{" "}
            <Term id="CAC">CAC</Term> ≈ paid CAC × (1 − K). Even a sub-viral
            loop <Term id="AMP">amplifies</Term> every paid cohort.
          </CalcNote>

          <div className="mt-5">
            <Slider
              label="Invites sent per user"
              value={invites}
              min={0}
              max={8}
              step={0.1}
              onChange={(v) => setField("inv", v)}
              onCommit={commitVirality}
              display={invites.toFixed(1)}
            />
            <Slider
              label="Invite → signup conversion"
              value={conv}
              min={0}
              max={60}
              step={1}
              onChange={(v) => setField("conv", v)}
              onCommit={commitVirality}
              display={fmtPct(conv)}
            />
          </div>

          <NumberRow className="mt-1">
            <NumberField
              label="Paid CAC to discount"
              value={cac}
              onChange={(v) => {
                setField("kCAC", v);
                commitVirality();
              }}
              min={0}
              prefix={symbol}
            />
          </NumberRow>

          <StatGrid className="mt-6">
            <Stat
              k={<Term id="KFAC">K-factor</Term>}
              n={k.toFixed(2)}
              tone={kTone}
              sub={mode}
            />
            <Stat
              k={<Term id="AMP">Amplification</Term>}
              n={amplification}
              sub="1 ÷ (1 − K)"
            />
            <Stat
              k="Effective CAC"
              n={effectiveCAC}
              tone="good"
              sub="after free virality"
            />
          </StatGrid>
        </CalcPanel>
      </div>

      <MeansForYou tone={nrrTone}>
        Your existing customers are returning{" "}
        <Fig tone={nrrTone}>{fmtPct(nrr)}</Fig> of last period's revenue —{" "}
        {nrr >= 120
          ? "elite territory, the base compounds on its own"
          : nrr >= 100
            ? "just above break-even, so the base grows slowly without new logos"
            : "below break-even, so you lose ground unless you keep selling"}
        . You hold <Fig tone={grrTone}>{fmtPct(grr)}</Fig> before upgrades, and
        a quick ratio of <Fig tone={qrTone}>{qr.toFixed(1)}</Fig> means you{" "}
        {qr >= 4
          ? "add far more than you bleed"
          : qr >= 2
            ? "add more than you bleed"
            : "barely out-add what you bleed"}
        . And each user's <Fig>{invites.toFixed(1)}</Fig> invites at{" "}
        <Fig>{fmtPct(conv)}</Fig> give a K of{" "}
        <Fig tone={kTone}>{k.toFixed(2)}</Fig> —{" "}
        {viral
          ? "self-sustaining, so acquisition pays for itself"
          : `not viral, but still enough to cut a ${money(cac)} CAC to ${effectiveCAC}`}
        .
      </MeansForYou>

      <Play
        moves={[
          "Onboard to the aha moment — the highest-leverage retention fix there is. Find the action retained users take that churned users don't, and drive everyone to it fast.",
          "Win-back sequences triggered by a drop in product activity, not the calendar — reach out before the renewal, not after.",
          "Expansion nudges when an account hits a usage limit; save-offers before a renewal date.",
          "Recurring warmth — weekly digests, milestone and anniversary emails, NPS follow-ups — to keep cohorts from going cold.",
        ]}
        consider="the lifecycle emails you are NOT sending? Most teams have a welcome email and then silence until the cancellation. Channels: lifecycle email, in-app, and your community (Discord / Slack)."
      />

      <Explainer summary="How do I read NRR, and why does it matter so much?">
        <p>
          Take <b>only the customers you already had</b> — ignore anyone new. A
          year on, some upgraded (<b>expansion</b>), some downgraded (
          <b>contraction</b>), and some left (<b>churn</b>). <code>NRR</code> is
          simply where that group's revenue <b>landed</b> versus where it{" "}
          <b>started</b>. Above 100% and your existing base grows on its own,
          before you win a single new logo.
        </p>
        <p>
          <code>GRR</code> is the same sum but it <b>ignores upgrades</b>, so it
          can never exceed 100% — it's the honest answer to "how leaky is the{" "}
          bucket?" The <b>quick ratio</b> divides what you <b>added</b> (new +{" "}
          expansion) by what you <b>lost</b> (contraction + churn): above 4 is{" "}
          efficient growth, near 1 means you're running just to stand still.
        </p>
        <p>
          The <b>K-factor</b> closes the loop. Every customer who refers another{" "}
          lowers your <b>true</b> cost per customer, because some arrivals were{" "}
          free. Even a non-viral <code>K</code> of 0.4 cuts your effective CAC{" "}
          by 40% — virality doesn't have to explode to pay for itself.
        </p>
      </Explainer>
    </Section>
  );
}
