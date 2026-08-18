// ---------------------------------------------------------------------------
// Contact-traits registry (open, augmentable — the trait sibling of
// `FlagRegistryMap` in `@hogsend/core/flags-registry`)
// ---------------------------------------------------------------------------

/**
 * The set of contact trait keys readable from the browser, and the VALUE TYPE
 * each key carries. This interface ships EMPTY: `@hogsend/core` bakes in no
 * concrete traits, because which traits are readable is an OPERATOR decision
 * (the engine's `contacts.publicProperties` allowlist). A consumer declares
 * theirs by augmenting it with the same keys they allowlisted:
 *
 * ```ts
 * declare module "@hogsend/core" {
 *   interface ContactTraitsMap {
 *     plan: "free" | "pro";
 *     seats: number;
 *   }
 * }
 * ```
 *
 * After augmentation, {@link TraitKey} resolves to the consumer's keys and the
 * typed `useTrait`/`useContact` (`@hogsend/react`) type-check the key + narrow
 * the value. UNaugmented, both degrade to today's `string`-keyed /
 * `unknown`-valued surface with no break.
 *
 * Augmenting this map does NOT expose a trait — the engine's allowlist is the
 * only thing that does. A key declared here but not allowlisted simply reads
 * `undefined` at runtime.
 */
// biome-ignore lint/suspicious/noEmptyInterface: intentionally open for consumer augmentation
export interface ContactTraitsMap {}

/**
 * The union of augmented trait keys, or `never` when the map is unaugmented.
 * The typed SDK surfaces constrain their `key` argument to this.
 */
export type TraitKey = keyof ContactTraitsMap;

/**
 * `true` when {@link ContactTraitsMap} carries no augmented keys. The
 * `[keyof T] extends [never]` form is the distribution-safe "is `never`" check
 * (the same probe `IsEmptyFlagRegistry` uses). The typed `useContact`/`useTrait`
 * surfaces branch on this to degrade to their permissive shape.
 */
export type IsEmptyTraitsMap = [keyof ContactTraitsMap] extends [never]
  ? true
  : false;
