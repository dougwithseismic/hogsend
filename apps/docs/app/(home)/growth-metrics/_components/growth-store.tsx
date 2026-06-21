"use client";

/* ========================================================================== */
/*  Growth store — one shared input model for every calculator on the page.   */
/*                                                                            */
/*  The "Start here" intake holds six plain-English answers (revenue,         */
/*  customers, spend, new customers, churned customers, gross margin). From    */
/*  those we DERIVE the jargon (ARPA, CAC, churn, lifetime) and SEED every     */
/*  downstream calculator's inputs. Each calculator then reads/writes its own  */
/*  slice via setField, so a slider drag is an independent "what-if" that does  */
/*  not touch the intake. Editing the intake (or loading a preset) re-seeds    */
/*  the seeded fields but preserves the purely-exploratory ones (scale,        */
/*  saturation, invites, growth/margin, burn, lifecycle lift/cut).            */
/* ========================================================================== */

import {
  createContext,
  type JSX,
  type ReactNode,
  useContext,
  useMemo,
  useState,
} from "react";

const clamp = (n: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, n));

/** The six plain-English intake answers. */
export type RawKey = "rev" | "cust" | "spend" | "newCust" | "lost" | "gm";

export type GrowthInputs = {
  // Start-here raw answers
  rev: number;
  cust: number;
  spend: number;
  newCust: number;
  lost: number;
  gm: number;
  // Unit economics (seeded, editable)
  arpa: number;
  gmPct: number;
  churnPct: number;
  cac: number;
  // Blended vs paid CAC
  pSpend: number;
  pCust: number;
  oCust: number;
  scale: number;
  sat: number;
  // Retention
  sMRR: number;
  newMRR: number;
  expMRR: number;
  conMRR: number;
  chMRR: number;
  // Virality
  inv: number;
  conv: number;
  kCAC: number;
  // Efficiency
  nnARR: number;
  priorSM: number;
  grw: number;
  mgn: number;
  burn: number;
  burnARR: number;
  // Lifecycle touch calculator (subset seeded from intake)
  lcNewUsers: number;
  lcBaseAct: number;
  lcLift: number;
  lcBaseChurn: number;
  lcCut: number;
  lcArpa: number;
  lcGm: number;
};

type RawAnswers = Pick<GrowthInputs, RawKey>;

/** Derived headline numbers shown in the intake chips (pure function of raw). */
export type Derived = {
  arpa: number;
  cac: number;
  churnPct: number;
  life: number;
};

export function deriveFromRaw(raw: RawAnswers): Derived {
  const cust = Math.max(raw.cust, 1);
  const newCust = Math.max(raw.newCust, 1);
  const arpa = raw.rev / cust;
  const cac = raw.spend / newCust;
  const churnPct = clamp((raw.lost / cust) * 100, 0.2, 20);
  const life = 1 / (churnPct / 100);
  return { arpa, cac, churnPct, life };
}

/** The seeded slice — recomputed whenever the intake answers change. */
function seed(raw: RawAnswers): Partial<GrowthInputs> {
  const newCust = Math.max(raw.newCust, 1);
  const { arpa, cac, churnPct } = deriveFromRaw(raw);
  const newMRR = Math.round(newCust * arpa);
  const expMRR = Math.round(raw.rev * 0.08);
  const conMRR = Math.round(raw.rev * 0.02);
  const chMRR = Math.round(raw.lost * arpa);
  const nn = newMRR + expMRR - conMRR - chMRR;
  const annualNetNew = Math.round(Math.max(nn, 0) * 12);
  return {
    arpa,
    gmPct: raw.gm,
    churnPct,
    cac,
    pSpend: Math.round(raw.spend),
    pCust: Math.max(Math.round(newCust * 0.6), 1),
    oCust: Math.max(Math.round(newCust * 0.4), 1),
    kCAC: Math.round(cac),
    sMRR: Math.round(raw.rev),
    newMRR,
    expMRR,
    conMRR,
    chMRR,
    nnARR: annualNetNew,
    priorSM: Math.round(raw.spend * 3),
    burnARR: annualNetNew,
    // Net burn proxy: ~2× annual S&M (assume non-S&M opex ≈ S&M early on) minus
    // annual gross profit, floored at 0 — keeps the burn multiple realistic and
    // scaled to the business instead of a fixed enterprise figure.
    burn: Math.max(
      Math.round(raw.spend * 12 * 2 - raw.rev * (raw.gm / 100) * 12),
      0,
    ),
    lcNewUsers: Math.max(Math.round(newCust), 1),
    lcBaseChurn: Number(churnPct.toFixed(1)),
    lcArpa: Math.round(arpa),
    lcGm: raw.gm,
  };
}

/** Starting answers = the "Early SaaS" preset. */
const DEFAULT_RAW: RawAnswers = {
  rev: 18000,
  cust: 300,
  spend: 10000,
  newCust: 40,
  lost: 12,
  gm: 82,
};

/** Fields that intake editing must NOT clobber — pure exploration knobs. */
const EXPLORATORY_DEFAULTS = {
  scale: 1,
  sat: 0,
  inv: 2,
  conv: 20,
  grw: 60,
  mgn: -15,
  lcBaseAct: 35,
  lcLift: 8,
  lcCut: 1,
} as const;

function initialInputs(): GrowthInputs {
  return {
    ...DEFAULT_RAW,
    ...EXPLORATORY_DEFAULTS,
    ...seed(DEFAULT_RAW),
  } as GrowthInputs;
}

export type PresetId = "saas" | "agency" | "ecom" | "explore";

export const PRESETS: Record<PresetId, { label: string; raw: RawAnswers }> = {
  saas: {
    label: "Early SaaS",
    raw: { rev: 18000, cust: 300, spend: 10000, newCust: 40, lost: 12, gm: 82 },
  },
  agency: {
    label: "Agency / services",
    raw: { rev: 42000, cust: 12, spend: 2500, newCust: 1, lost: 0.3, gm: 45 },
  },
  ecom: {
    label: "E-commerce / repeat",
    raw: {
      rev: 60000,
      cust: 4000,
      spend: 11000,
      newCust: 480,
      lost: 320,
      gm: 34,
    },
  },
  explore: {
    label: "I'm just exploring",
    raw: { rev: 8000, cust: 120, spend: 3000, newCust: 18, lost: 5, gm: 78 },
  },
};

type GrowthContextValue = {
  inputs: GrowthInputs;
  derived: Derived;
  /** Set any single field (a calculator's own "what-if" — does not re-seed). */
  setField: <K extends keyof GrowthInputs>(
    key: K,
    value: GrowthInputs[K],
  ) => void;
  /** Set one intake answer and re-seed the downstream calculators. */
  setIntake: (key: RawKey, value: number) => void;
  /** Load a preset's answers and re-seed. */
  loadPreset: (id: PresetId) => void;
};

const GrowthContext = createContext<GrowthContextValue | null>(null);

export function GrowthStoreProvider({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  const [inputs, setInputs] = useState<GrowthInputs>(initialInputs);

  const value = useMemo<GrowthContextValue>(() => {
    const derived = deriveFromRaw(inputs);

    const setField = <K extends keyof GrowthInputs>(
      key: K,
      next: GrowthInputs[K],
    ): void => {
      setInputs((prev) => ({ ...prev, [key]: next }));
    };

    const setIntake = (key: RawKey, next: number): void => {
      setInputs((prev) => {
        const raw: RawAnswers = {
          rev: prev.rev,
          cust: prev.cust,
          spend: prev.spend,
          newCust: prev.newCust,
          lost: prev.lost,
          gm: prev.gm,
          [key]: next,
        };
        return { ...prev, [key]: next, ...seed(raw) };
      });
    };

    const loadPreset = (id: PresetId): void => {
      const { raw } = PRESETS[id];
      setInputs((prev) => ({ ...prev, ...raw, ...seed(raw) }));
    };

    return { inputs, derived, setField, setIntake, loadPreset };
  }, [inputs]);

  return (
    <GrowthContext.Provider value={value}>{children}</GrowthContext.Provider>
  );
}

export function useGrowth(): GrowthContextValue {
  const ctx = useContext(GrowthContext);
  if (!ctx) {
    throw new Error("useGrowth must be used within a GrowthStoreProvider");
  }
  return ctx;
}
