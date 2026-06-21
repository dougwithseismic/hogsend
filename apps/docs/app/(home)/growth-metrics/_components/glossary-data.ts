/* ========================================================================== */
/*  Glossary dictionary — single source of truth for inline term tooltips.    */
/*  Each entry: a title, a plain-English one-liner, and an optional formula.   */
/*  Consumed by the <Term> component (calc-kit) and surfaced as the           */
/*  DefinedTermSet JSON-LD on the page.                                       */
/* ========================================================================== */

export type GlossEntry = {
  /** Heading shown at the top of the tooltip. */
  title: string;
  /** One sentence, jargon-free. */
  plain: string;
  /** Optional formula line (mono). */
  formula?: string;
};

export const GLOSS = {
  ARPA: {
    title: "ARPA — average revenue per account",
    plain: "What one customer pays you in a typical month, on average.",
    formula: "monthly revenue ÷ customers",
  },
  MRR: {
    title: "MRR — monthly recurring revenue",
    plain: "The predictable subscription income you bill every month.",
    formula: "ARR ÷ 12",
  },
  ARR: {
    title: "ARR — annual recurring revenue",
    plain: "Your yearly run-rate of recurring revenue.",
    formula: "MRR × 12",
  },
  CAC: {
    title: "CAC — customer acquisition cost",
    plain: "What it costs to win one new customer, all-in.",
    formula: "sales + marketing ÷ new customers",
  },
  SM: {
    title: "S&M — sales & marketing",
    plain:
      "Everything you spend to win and keep customers: ads, content, sales salaries, and the tools behind them.",
  },
  CONTRIB: {
    title: "Contribution margin",
    plain:
      "Gross margin minus the variable cost of selling (ad-to-sale fees, onboarding time). Stricter than gross margin.",
    formula: "revenue − variable cost (per unit)",
  },
  BLENDED: {
    title: "Blended CAC",
    plain:
      "Cost per customer averaged across every channel — including the free organic ones, which flatter it.",
    formula: "total S&M ÷ all new customers",
  },
  PAID: {
    title: "Paid CAC",
    plain:
      "Cost per customer from paid channels only — the true price of a bought customer.",
    formula: "paid spend ÷ paid customers",
  },
  MARGINAL: {
    title: "Marginal CAC",
    plain:
      "What the very next customer costs. Climbs as a channel saturates and the easy audience runs out.",
    formula: "Δ spend ÷ Δ customers",
  },
  LTV: {
    title: "LTV — lifetime value",
    plain: "Total gross profit one customer brings before they leave.",
    formula: "ARPA × margin ÷ churn",
  },
  GM: {
    title: "Gross margin",
    plain:
      "The share of revenue left after the direct cost of delivering your product or service.",
  },
  CHURN: {
    title: "Churn",
    plain: "The share of customers (or revenue) you lose each month.",
    formula: "lost ÷ starting count",
  },
  LIFETIME: {
    title: "Customer lifetime",
    plain: "How long an average customer stays with you.",
    formula: "1 ÷ monthly churn",
  },
  RATIO: {
    title: "LTV : CAC",
    plain:
      "How many times over a customer repays what you spent to acquire them. 3:1 is the healthy benchmark.",
    formula: "LTV ÷ CAC",
  },
  PAYBACK: {
    title: "CAC payback",
    plain: "How many months of gross profit it takes to earn back the CAC.",
    formula: "CAC ÷ (ARPA × margin)",
  },
  CEILING: {
    title: "Affordable CAC",
    plain: "The most you can pay per customer and still hit a 3:1 return.",
    formula: "LTV ÷ 3",
  },
  NRR: {
    title: "NRR — net revenue retention",
    plain:
      "Where last year's customers' revenue lands a year on — counting upgrades and cancellations. Over 100% grows itself.",
    formula: "(start + expansion − contraction − churn) ÷ start",
  },
  GRR: {
    title: "GRR — gross revenue retention",
    plain: "Like NRR but ignoring upgrades — pure stickiness. Caps at 100%.",
    formula: "(start − contraction − churn) ÷ start",
  },
  EXPANSION: {
    title: "Expansion",
    plain:
      "Extra revenue from existing customers — upgrades, more seats, add-ons.",
  },
  CONTRACTION: {
    title: "Contraction",
    plain: "Existing customers downgrading to a smaller plan.",
  },
  QR: {
    title: "Quick ratio",
    plain: "Growth quality: revenue you added versus revenue you lost.",
    formula: "(new + expansion) ÷ (churned + contraction)",
  },
  NETNEW: {
    title: "Net new MRR",
    plain: "The month's real movement after wins and losses.",
    formula: "new + expansion − contraction − churn",
  },
  KFAC: {
    title: "K-factor (viral coefficient)",
    plain:
      "How many new users each user brings in. Above 1 and growth self-sustains.",
    formula: "invites per user × their conversion rate",
  },
  AMP: {
    title: "Amplification",
    plain: "How much virality multiplies every cohort you acquire.",
    formula: "1 ÷ (1 − K)",
  },
  CYCLE: {
    title: "Viral cycle time",
    plain:
      "How long one turn of the loop takes — from a user joining to bringing the next person in.",
    formula: "join → invite → signup, elapsed",
  },
  LOOP: {
    title: "Growth loop",
    plain:
      "A cycle whose output becomes its next input — users invite users, content earns traffic that makes more content.",
  },
  MAGIC: {
    title: "Magic number",
    plain:
      "Sales efficiency — new annual revenue earned per pound of sales & marketing.",
    formula: "net new ARR ÷ prior-quarter S&M",
  },
  R40: {
    title: "Rule of 40",
    plain:
      "Growth rate plus profit margin should clear 40. Trade one for the other, but the sum should hold.",
    formula: "growth % + profit margin %",
  },
  BURN: {
    title: "Burn multiple",
    plain:
      "Cash burned for every pound of new recurring revenue. Lower is leaner.",
    formula: "net burn ÷ net new ARR",
  },
} as const;

export type GlossId = keyof typeof GLOSS;
