"use client";

import {
  createContext,
  type ReactNode,
  useContext,
  useMemo,
  useState,
} from "react";

/**
 * The landing page's shared visitor-team persona.
 *
 * The "What's your team?" flag switcher writes it; any product surface on the
 * page can read it and react (the journey code picker pre-selects a use case,
 * the email demo addresses the right audience, …). One selection, one page
 * that reshapes itself around it — the same story the `visitor-team` flag
 * tells in production.
 *
 * Deliberately a plain context over `useState`: no persistence, no reducer.
 * The provider mounts in the (landing) layout so every section sees it.
 */

export type TeamKey = "founder" | "growth" | "product" | "sales" | "hr";

export const TEAM_ORDER: readonly TeamKey[] = [
  "founder",
  "growth",
  "product",
  "sales",
  "hr",
];

export const TEAM_LABELS: Record<TeamKey, string> = {
  founder: "Founder",
  growth: "Growth",
  product: "Product",
  sales: "Sales",
  hr: "HR",
};

interface VisitorTeamValue {
  team: TeamKey;
  setTeam: (team: TeamKey) => void;
}

const VisitorTeamContext = createContext<VisitorTeamValue | null>(null);

export function VisitorTeamProvider({ children }: { children: ReactNode }) {
  const [team, setTeam] = useState<TeamKey>("founder");
  const value = useMemo(() => ({ team, setTeam }), [team]);
  return (
    <VisitorTeamContext.Provider value={value}>
      {children}
    </VisitorTeamContext.Provider>
  );
}

export function useVisitorTeam(): VisitorTeamValue {
  const value = useContext(VisitorTeamContext);
  if (!value) {
    throw new Error("useVisitorTeam requires a <VisitorTeamProvider> ancestor");
  }
  return value;
}
