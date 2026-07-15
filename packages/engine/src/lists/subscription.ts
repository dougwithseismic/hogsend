/**
 * Pure list-polarity decision shared by production registries and deterministic
 * journey tests.
 */
export function isListSubscribed(opts: {
  categories: Record<string, boolean>;
  id: string;
  defaultOptIn: boolean;
}): boolean {
  return opts.defaultOptIn
    ? opts.categories[opts.id] !== false
    : opts.categories[opts.id] === true;
}
