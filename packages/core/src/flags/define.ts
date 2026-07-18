import { flagDefineSchema } from "./schema.js";
import type { FlagType } from "./types.js";

/**
 * A multivariate arm as authored in a {@link defineFlag} call — the same shape
 * as the stored {@link FlagVariant} but with its `value` parameterized so the
 * factory can infer the served-value union from the literals.
 */
export interface DefinedFlagVariant<Value = unknown> {
  key: string;
  value: Value;
  weight: number;
}

/**
 * The CONTRACT half of a native feature flag, authored in code with
 * {@link defineFlag}. Deliberately NOT the full row: `targeting`, `rollout`,
 * and `conditionSets` are DB/operator-owned (Studio + the admin API) and are
 * NEVER expressed here — a code definition seeds the flag's identity and its
 * served shape, then the reconciler leaves operator state alone forever after.
 *
 * `enabled` is a one-time CREATE seed (default `false`): a freshly-reconciled
 * flag is born OFF so a deploy never silently flips traffic; an operator turns
 * it on. It is honoured only on the INSERT, never on a later contract sync.
 */
export interface FlagDefineMeta<Value = unknown> {
  /** Stable identifier a client evaluates against (e.g. "docs-preview-banner"). */
  key: string;
  name: string;
  type: FlagType;
  /** Multivariate arms. Omit / empty for a boolean flag. */
  variants?: ReadonlyArray<DefinedFlagVariant<Value>>;
  /**
   * Served when disabled / targeting fails / not in the rollout slice. Defaults
   * to `false` for a boolean flag, `null` for a multivariate flag.
   */
  defaultValue?: Value;
  description?: string;
  /** One-time CREATE seed for the row's master switch. Default `false`. */
  enabled?: boolean;
}

/**
 * The served-value type of a flag definition: `boolean` for a boolean flag, or
 * the union of the authored `variants[].value` literals for a multivariate flag.
 * Purely a compile-time projection (feeds a later flag-value codegen); it has no
 * runtime footprint.
 */
export type FlagValueOf<M> = M extends { type: "boolean" }
  ? boolean
  : M extends { variants: ReadonlyArray<{ value: infer V }> }
    ? V
    : unknown;

/**
 * A validated flag definition — the identity returned by {@link defineFlag}.
 * `Value` is the served-value type (see {@link FlagValueOf}); it exists for
 * codegen/inference and carries no runtime data beyond `meta`.
 */
export interface DefinedFlag<Value = unknown> {
  meta: FlagDefineMeta<Value>;
}

/**
 * Identity/validating factory for a code-first feature flag — the flag sibling
 * of `defineConversion`/`defineCampaign`. Validates the CONTRACT fields at
 * definition time (throwing on a malformed definition) and returns
 * `{ meta }`. State (`targeting`/`rollout`/`conditionSets`/`enabled` after
 * create) stays DB-owned; the boot reconciler upserts the row.
 *
 * The `const` type parameter preserves the authored `variants[].value` literals
 * so `DefinedFlag`'s served-value type is exact.
 */
export function defineFlag<const M extends FlagDefineMeta>(
  meta: M,
): DefinedFlag<FlagValueOf<M>> {
  flagDefineSchema.parse(meta);
  return { meta } as DefinedFlag<FlagValueOf<M>>;
}
