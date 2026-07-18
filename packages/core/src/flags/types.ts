import type { PropertyCondition } from "../types/conditions.js";

/** The two shapes a flag can serve. */
export type FlagType = "boolean" | "multivariate";

/**
 * One multivariate arm of a flag: a keyed value served to a slice of the
 * rollout, sized by `weight` (weights are relative; the engine picks by
 * cumulative weight over a deterministic unit-hash of contactKey+flagKey).
 */
export interface FlagVariant {
  key: string;
  value: unknown;
  weight: number;
}

/**
 * The portable domain shape of a native, DB-backed feature flag. Evaluation is
 * STICKY by construction (a deterministic hash of contactKey+flagKey), so there
 * is no per-user assignment. Hand-written and decoupled from the drizzle row so
 * SDK consumers don't take a DB dependency — kept in sync with the `flags`
 * table (`@hogsend/db`).
 */
export interface FlagDefinition {
  id: string;
  /** The stable string identifier a client evaluates against. */
  key: string;
  name: string;
  description: string | null;
  /** Master switch: a disabled flag always serves `defaultValue`. */
  enabled: boolean;
  type: FlagType;
  /** Multivariate arms. Empty for a boolean flag. */
  variants: FlagVariant[];
  /**
   * Served when the flag is disabled, targeting fails, or the contact is not in
   * the rollout slice. For a boolean flag this is `false`.
   */
  defaultValue: unknown;
  /** Targeting predicate. Empty means everyone matches. */
  targeting: PropertyCondition[];
  /** Percent (0-100) of the targeted audience eligible for a non-default value. */
  rollout: number;
  /** Provenance seam for deferred provider sync — "native" today. */
  origin: string;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
