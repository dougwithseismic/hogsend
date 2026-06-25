/**
 * Data-attribute variant helper — the sanctioned alternative to CVA (§6). Our
 * components drop into ANY host app without Tailwind, styled by `--hs-*` vars
 * and `data-*` state. Variants therefore become `data-*` attributes the CSS
 * targets, not composed class strings. CVA would earn nothing here and add a
 * dep — so this maps a prop bag → a `data-*` attribute bag instead.
 */

/** A bag of variant prop values (string | boolean | number | undefined). */
export type VariantProps = Record<
  string,
  string | number | boolean | undefined
>;

/** The resulting `data-*` attribute bag, ready to spread onto an element. */
export type DataAttributes = Record<string, string>;

/**
 * Map a variant prop bag to `data-*` attributes. Boolean `true` emits a bare
 * presence attr (`data-unread=""`); `false`/`undefined` are dropped; other
 * scalars stringify. Keys are kebab-cased and prefixed `data-`.
 *
 * @example
 *   dataVariants({ state: "unread", unseen: true, dismissed: false })
 *   // → { "data-state": "unread", "data-unseen": "" }
 */
export function dataVariants(props: VariantProps): DataAttributes {
  const out: DataAttributes = {};
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    const attr = `data-${toKebab(key)}`;
    out[attr] = value === true ? "" : String(value);
  }
  return out;
}

function toKebab(key: string): string {
  return key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}
