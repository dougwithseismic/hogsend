/**
 * Calculator presets for the <Calculator preset="…"> lesson block. Each preset
 * owns its inputs, derived outputs, and a plain-language read-out — the math and
 * the "what this number means" live here, so the MDX only picks a preset + an id
 * (the persistence key) and writes the surrounding "why the number matters" prose.
 *
 * Pure data + functions, no React — imported by the client Calculator component,
 * so `compute`/`readout` run client-side (they are NEVER passed across the
 * server→client boundary as props, which RSC forbids for functions).
 *
 * Every formula guards divide-by-zero; the component drops non-finite results
 * before rendering or saving. Defaults are illustrative, deliberately round
 * numbers — a reader replaces them with their own.
 */

export type CalcFormat =
  | "number"
  | "currency"
  | "percent"
  | "x" // a multiple, e.g. "3.2×"
  | "months"
  | "ratio";

export type CalcInput = {
  key: string;
  label: string;
  default: number;
  min?: number;
  max?: number;
  step?: number;
  /** Unit shown before/after the field ($, %, /mo). */
  prefix?: string;
  suffix?: string;
  /** One-line hint under the field. */
  help?: string;
};

export type CalcOutput = {
  key: string;
  label: string;
  format: CalcFormat;
  /** Emphasise this as the headline number. */
  primary?: boolean;
  /** Green when true, plain otherwise — a quick good/watch signal. */
  good?: (value: number, results: Record<string, number>) => boolean;
};

export type CalcPreset = {
  title: string;
  inputs: CalcInput[];
  outputs: CalcOutput[];
  compute: (i: Record<string, number>) => Record<string, number>;
  readout: (i: Record<string, number>, o: Record<string, number>) => string;
};

const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const round1 = (n: number) => Math.round(n * 10) / 10;

export const CALCULATORS: Record<string, CalcPreset> = {
  // Ch2 — the leaky bucket, made numeric. Steady-state active users ≈ new /
  // churn, so a few points of retention move the whole base.
  "retention-compounder": {
    title: "The leaky bucket, in numbers",
    inputs: [
      {
        key: "newUsers",
        label: "New activated users per month",
        default: 500,
        min: 0,
        step: 10,
        suffix: "/mo",
      },
      {
        key: "retNow",
        label: "Monthly retention now",
        default: 80,
        min: 1,
        max: 99,
        step: 1,
        suffix: "%",
        help: "The share of active users still active a month later.",
      },
      {
        key: "retNew",
        label: "Retention after your fix",
        default: 88,
        min: 1,
        max: 99,
        step: 1,
        suffix: "%",
      },
    ],
    compute: (i) => {
      const churnNow = Math.max(1 - i.retNow / 100, 0.0001);
      const churnNew = Math.max(1 - i.retNew / 100, 0.0001);
      const steadyNow = i.newUsers / churnNow;
      const steadyNew = i.newUsers / churnNew;
      return {
        steadyNow,
        steadyNew,
        extra: steadyNew - steadyNow,
        gainPct:
          steadyNow > 0 ? ((steadyNew - steadyNow) / steadyNow) * 100 : 0,
      };
    },
    outputs: [
      { key: "steadyNow", label: "Steady-state base now", format: "number" },
      {
        key: "steadyNew",
        label: "After the retention fix",
        format: "number",
        primary: true,
      },
      { key: "extra", label: "Extra active users", format: "number" },
      { key: "gainPct", label: "Growth, same acquisition", format: "percent" },
    ],
    readout: (i, o) =>
      `Holding acquisition flat, lifting monthly retention from ${i.retNow}% to ${i.retNew}% grows your steady-state base from about ${Math.round(
        o.steadyNow,
      ).toLocaleString("en-US")} to ${Math.round(o.steadyNew).toLocaleString(
        "en-US",
      )} — ${Math.round(o.extra).toLocaleString(
        "en-US",
      )} more active users (+${round1(o.gainPct)}%) from the leak you plugged, not a bigger top of funnel.`,
  },

  // Ch7 — the unit-economics gate. LTV = margin-adjusted revenue over the
  // customer's lifetime (1/churn months); payback = months to earn CAC back.
  "cac-ltv-payback": {
    title: "CAC · LTV · payback",
    inputs: [
      {
        key: "cac",
        label: "Cost to acquire a customer",
        default: 120,
        min: 0,
        prefix: "$",
      },
      {
        key: "arpu",
        label: "Revenue per customer",
        default: 40,
        min: 0,
        prefix: "$",
        suffix: "/mo",
      },
      {
        key: "margin",
        label: "Gross margin",
        default: 80,
        min: 1,
        max: 100,
        step: 1,
        suffix: "%",
        help: "Revenue left after the cost of serving the customer.",
      },
      {
        key: "churn",
        label: "Monthly churn",
        default: 4,
        min: 0.1,
        max: 100,
        step: 0.1,
        suffix: "%",
        help: "Share of customers who cancel each month.",
      },
    ],
    compute: (i) => {
      const marginRev = i.arpu * (i.margin / 100);
      const lifetimeMonths = i.churn > 0 ? 100 / i.churn : 0;
      const ltv = marginRev * lifetimeMonths;
      return {
        ltv,
        ratio: i.cac > 0 ? ltv / i.cac : 0,
        payback: marginRev > 0 ? i.cac / marginRev : 0,
        lifetimeMonths,
      };
    },
    outputs: [
      { key: "ltv", label: "Lifetime value", format: "currency" },
      {
        key: "ratio",
        label: "LTV : CAC",
        format: "x",
        primary: true,
        good: (v) => v >= 3,
      },
      {
        key: "payback",
        label: "Payback period",
        format: "months",
        good: (v) => v > 0 && v <= 12,
      },
    ],
    readout: (i, o) => {
      const ratioNote =
        o.ratio >= 3
          ? "at or above the 3× rule of thumb — the economics carry paid acquisition"
          : o.ratio >= 1
            ? "positive but under 3× — paid works only if you tighten CAC, churn, or price first"
            : "under 1× — you'd lose money on every acquired customer";
      const payNote =
        o.payback > 0 && o.payback <= 12
          ? "and you earn CAC back inside a year"
          : "and payback runs past a year, which strains cash long before it strains the model";
      return `At $${Math.round(i.cac)} CAC, each customer is worth about ${money(
        o.ltv,
      )} over ~${round1(o.lifetimeMonths)} months — an LTV:CAC of ${round1(
        o.ratio,
      )}×, ${ratioNote}, ${payNote} (${round1(o.payback)} months).`;
    },
  },

  // Ch7/Ch10 — the "is paid even affordable yet?" gate against runway.
  "paid-readiness": {
    title: "Can you afford paid yet?",
    inputs: [
      {
        key: "budget",
        label: "Monthly paid budget",
        default: 5000,
        min: 0,
        prefix: "$",
        suffix: "/mo",
      },
      {
        key: "cac",
        label: "Cost to acquire a customer",
        default: 120,
        min: 1,
        prefix: "$",
      },
      {
        key: "payback",
        label: "Payback period",
        default: 9,
        min: 0.1,
        step: 0.5,
        suffix: "mo",
        help: "Months to earn CAC back (from the CAC·LTV calculator).",
      },
      {
        key: "runway",
        label: "Runway left",
        default: 12,
        min: 0,
        step: 1,
        suffix: "mo",
      },
    ],
    compute: (i) => ({
      customers: i.cac > 0 ? i.budget / i.cac : 0,
      annualSpend: i.budget * 12,
      slack: i.runway - i.payback,
    }),
    outputs: [
      {
        key: "customers",
        label: "Customers bought / month",
        format: "number",
        primary: true,
      },
      { key: "annualSpend", label: "Annual paid spend", format: "currency" },
      {
        key: "slack",
        label: "Runway minus payback",
        format: "months",
        good: (v) => v >= 3,
      },
    ],
    readout: (i, o) => {
      const verdict =
        o.slack >= 3
          ? "each cohort repays comfortably inside your runway — paid is affordable if the funnel underneath it holds"
          : o.slack >= 0
            ? "payback lands right at the edge of your runway — scale slowly and watch cash, not just CAC"
            : "payback outlasts your runway — paid would spend cash you can't wait to recover; fix retention or price first";
      return `A $${Math.round(i.budget).toLocaleString(
        "en-US",
      )}/mo budget at $${Math.round(i.cac)} CAC buys about ${Math.round(
        o.customers,
      ).toLocaleString(
        "en-US",
      )} customers a month. With ${i.runway} months of runway and a ${i.payback}-month payback, ${verdict}.`;
    },
  },

  // Ch6 — the silent revenue leak dunning recovers.
  "dunning-recovery": {
    title: "What dunning is worth",
    inputs: [
      {
        key: "mrr",
        label: "Monthly recurring revenue",
        default: 40000,
        min: 0,
        prefix: "$",
        suffix: "/mo",
      },
      {
        key: "failRate",
        label: "Payments that fail each month",
        default: 6,
        min: 0,
        max: 100,
        step: 0.5,
        suffix: "%",
        help: "Involuntary churn — expired cards, insufficient funds.",
      },
      {
        key: "recoverRate",
        label: "Recovered by a dunning sequence",
        default: 60,
        min: 0,
        max: 100,
        step: 1,
        suffix: "%",
        help: "Typical retry + email flows recover half to three-quarters.",
      },
    ],
    compute: (i) => {
      const atRisk = i.mrr * (i.failRate / 100);
      const recovered = atRisk * (i.recoverRate / 100);
      return { atRisk, recovered, recoveredYear: recovered * 12 };
    },
    outputs: [
      { key: "atRisk", label: "At risk each month", format: "currency" },
      { key: "recovered", label: "Recovered each month", format: "currency" },
      {
        key: "recoveredYear",
        label: "Recovered per year",
        format: "currency",
        primary: true,
      },
    ],
    readout: (i, o) =>
      `About ${money(o.atRisk)} of your MRR fails silently every month. A dunning sequence that recovers ${i.recoverRate}% of it claws back roughly ${money(
        o.recovered,
      )}/mo — ${money(
        o.recoveredYear,
      )} a year — from customers who already chose to pay. That's why it's the fastest revenue win in the course.`,
  },

  // Ch8 — the referral loop's viral coefficient.
  "viral-k-factor": {
    title: "Your referral loop's k-factor",
    inputs: [
      {
        key: "invites",
        label: "Invites sent per active user",
        default: 2,
        min: 0,
        step: 0.1,
        help: "Over the user's lifetime, on average.",
      },
      {
        key: "conversion",
        label: "Invites that become users",
        default: 15,
        min: 0,
        max: 100,
        step: 1,
        suffix: "%",
      },
    ],
    compute: (i) => {
      const k = i.invites * (i.conversion / 100);
      return {
        k,
        amplification: k < 1 ? 1 / (1 - k) : 0,
      };
    },
    outputs: [
      {
        key: "k",
        label: "k-factor",
        format: "number",
        primary: true,
        good: (v) => v >= 1,
      },
      {
        key: "amplification",
        label: "Acquisition multiplier",
        format: "x",
        good: (v) => v >= 1.3,
      },
    ],
    readout: (_i, o) => {
      if (o.k >= 1) {
        return `k = ${round1(
          o.k,
        )}. At or above 1, every cohort more than replaces itself through referrals — a self-sustaining loop. Rare and powerful; guard against gaming it.`;
      }
      return `k = ${round1(
        o.k,
      )}. Below 1 a loop doesn't self-sustain, but it still amplifies every other channel by about ${round1(
        o.amplification,
      )}× — each 100 users you acquire bring ${Math.round(
        (o.amplification - 1) * 100,
      )} more for free. The lever is invites-per-user or invite conversion, not just "add a referral page".`;
    },
  },

  // Ch9/Ch10 — ICE scoring for the experiment backlog.
  "ice-score": {
    title: "Score an experiment (ICE)",
    inputs: [
      {
        key: "impact",
        label: "Impact",
        default: 7,
        min: 1,
        max: 10,
        step: 1,
        help: "If it works, how much does the metric move?",
      },
      {
        key: "confidence",
        label: "Confidence",
        default: 5,
        min: 1,
        max: 10,
        step: 1,
        help: "How sure are you it will work?",
      },
      {
        key: "ease",
        label: "Ease",
        default: 6,
        min: 1,
        max: 10,
        step: 1,
        help: "How little effort to ship and measure?",
      },
    ],
    compute: (i) => ({
      score: (i.impact + i.confidence + i.ease) / 3,
    }),
    outputs: [
      {
        key: "score",
        label: "ICE score (of 10)",
        format: "number",
        primary: true,
        good: (v) => v >= 7,
      },
    ],
    readout: (_i, o) => {
      const band =
        o.score >= 7
          ? "top of the backlog — pull it into this week's review"
          : o.score >= 5
            ? "worth a slot once the high scorers ship"
            : "park it; low expected value for the effort";
      return `ICE ${round1(
        o.score,
      )}/10 — ${band}. Score every idea the same way and the weekly ritual always pulls the highest-expected-value test, not the loudest one in the room.`;
    },
  },

  // Ch10 — the Sean Ellis 40% PMF test.
  "pmf-40": {
    title: "The 40% PMF test",
    inputs: [
      {
        key: "surveyed",
        label: "Users surveyed",
        default: 100,
        min: 1,
        step: 1,
      },
      {
        key: "veryDisappointed",
        label: "“Very disappointed” if it vanished",
        default: 35,
        min: 0,
        step: 1,
        help: "Count who chose the top option on the Sean Ellis survey.",
      },
    ],
    compute: (i) => ({
      pct: i.surveyed > 0 ? (i.veryDisappointed / i.surveyed) * 100 : 0,
    }),
    outputs: [
      {
        key: "pct",
        label: "Very disappointed",
        format: "percent",
        primary: true,
        good: (v) => v >= 40,
      },
    ],
    readout: (_i, o) =>
      o.pct >= 40
        ? `${round1(
            o.pct,
          )}% would be very disappointed to lose the product — at or above the 40% bar Sean Ellis found separates products with pull. This is the evidence that gates a major step-up in paid spend.`
        : `${round1(
            o.pct,
          )}% would be very disappointed — under the 40% bar. Money spent scaling acquisition now amplifies a product people can still take or leave; it's better spent on the core and the Keep phase.`,
  },

  // Ch2/Ch4 — activation as a growth lever on the SAME traffic.
  "activation-value": {
    title: "What a point of activation is worth",
    inputs: [
      {
        key: "signups",
        label: "Signups per month",
        default: 1000,
        min: 0,
        step: 10,
        suffix: "/mo",
      },
      {
        key: "actNow",
        label: "Activation rate now",
        default: 30,
        min: 0,
        max: 100,
        step: 1,
        suffix: "%",
      },
      {
        key: "actNew",
        label: "After onboarding work",
        default: 40,
        min: 0,
        max: 100,
        step: 1,
        suffix: "%",
      },
    ],
    compute: (i) => {
      const now = i.signups * (i.actNow / 100);
      const then = i.signups * (i.actNew / 100);
      return {
        now,
        then,
        extraMonth: then - now,
        extraYear: (then - now) * 12,
      };
    },
    outputs: [
      { key: "now", label: "Activated / month now", format: "number" },
      { key: "then", label: "After the fix", format: "number", primary: true },
      { key: "extraYear", label: "Extra activated / year", format: "number" },
    ],
    readout: (i, o) =>
      `Raising activation from ${i.actNow}% to ${i.actNew}% turns the same ${Math.round(
        i.signups,
      ).toLocaleString("en-US")} signups a month into ${Math.round(
        o.extraMonth,
      ).toLocaleString("en-US")} more activated users each month — ${Math.round(
        o.extraYear,
      ).toLocaleString(
        "en-US",
      )} a year — with zero extra acquisition. Onboarding is a growth channel that bills nobody.`,
  },
};

export type CalcPresetId = keyof typeof CALCULATORS;
