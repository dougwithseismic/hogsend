// ---------------------------------------------------------------------------
// Flag registry (open, augmentable — "module augmentation", the flag sibling of
// @hogsend/email's `TemplateRegistryMap`)
// ---------------------------------------------------------------------------

/**
 * The set of feature-flag keys known to the type system, and the served VALUE
 * TYPE each key evaluates to. This interface ships EMPTY: `@hogsend/core` bakes
 * in no concrete flags. A consumer declares theirs by augmenting it — the
 * codegen `hogsend flags generate` writes exactly this from their
 * `src/flags/index.ts`:
 *
 * ```ts
 * declare module "@hogsend/core" {
 *   interface FlagRegistryMap {
 *     "docs-preview-banner": boolean;
 *     "cta-copy": "urgent" | "calm";
 *   }
 * }
 * ```
 *
 * After augmentation, {@link FlagKey} resolves to the consumer's keys and the
 * typed `useFlag`/`useFlags` (`@hogsend/react`), browser `hogsend.getFlag`
 * (`@hogsend/js`), and server `client.flags.evaluate` (`@hogsend/client`) all
 * type-check the key + narrow the value. UNaugmented, every one of them
 * degrades to today's `string`-keyed / `unknown`-valued surface with no break.
 */
// biome-ignore lint/suspicious/noEmptyInterface: intentionally open for consumer augmentation (codegen)
export interface FlagRegistryMap {}

/**
 * The union of augmented flag keys, or `never` when the registry is unaugmented.
 * The typed SDK surfaces constrain their `key` argument to this.
 */
export type FlagKey = keyof FlagRegistryMap;

/**
 * `true` when {@link FlagRegistryMap} carries no augmented keys (the consumer
 * has not run the flags codegen). `[keyof FlagRegistryMap] extends [never]` is
 * the distribution-safe "is `never`" check — the same probe the email registry
 * uses for `IsEmptyRegistry`. The typed `useFlag`/`getFlag`/`evaluate` surfaces
 * branch on this to degrade to their permissive (`string` key / `unknown`
 * value) shape when unaugmented.
 */
export type IsEmptyFlagRegistry = [keyof FlagRegistryMap] extends [never]
  ? true
  : false;
