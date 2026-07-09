/**
 * Email lists (D3) — code-defined subscription categories layered on top of the
 * existing `email_preferences.categories` JSONB. A list is just a named category
 * with a declared default polarity (`defaultOptIn`); there is NO new table.
 *
 * `defineList()` is the authoring entry point, mirroring `defineBucket()` /
 * `defineJourney()`: a synchronous, definition-time call that validates the id
 * and returns a `DefinedList`. The id shares the `email_preferences.categories`
 * key namespace, so two ids are RESERVED for the engine's own non-list
 * categories (`transactional`, `journey`) and rejected here (open risk #11).
 */

/**
 * List ids that collide with the engine's built-in, non-list
 * `email_preferences.categories` keys — rejected by {@link defineList}, and
 * ALSO the allowlist of categories a template may legitimately carry that are
 * NOT a defined list (the boot-time template-category guard in `container.ts`
 * reuses this set so the two can never drift). Exported for that reuse.
 */
export const RESERVED_LIST_IDS = new Set(["transactional", "journey"]);

/**
 * Is `id` one of the reserved built-in categories ({@link RESERVED_LIST_IDS})?
 * Case-insensitive, matching the `defineList` reservation check — so callers
 * (e.g. the container's template-category validation) never re-implement the
 * comparison and can't drift from the reservation rule.
 */
export function isReservedListId(id: string): boolean {
  return RESERVED_LIST_IDS.has(id.toLowerCase());
}

/** Allowed list-id shape: alphanumerics, dash, underscore (case-insensitive). */
const LIST_ID_PATTERN = /^[a-z0-9_-]+$/i;

/**
 * The validated, fully-defaulted list metadata. `enabled` is always present
 * after `defineList` (defaults to `true`); authoring input leaves it optional.
 */
export interface ListMeta<Id extends string = string> {
  id: Id;
  name: string;
  description?: string;
  defaultOptIn: boolean;
  enabled: boolean;
}

/**
 * A defined list. `meta` carries the canonical, defaulted metadata; `id` is
 * surfaced directly for literal-typed consumption (mirrors `DefinedBucket`).
 */
export interface DefinedList<Id extends string = string> {
  readonly meta: ListMeta<Id>;
  readonly id: Id;
}

/**
 * Define an email list. Validates the id against {@link LIST_ID_PATTERN} and the
 * {@link RESERVED_LIST_IDS} blocklist (since list ids share the
 * `email_preferences.categories` namespace), then returns a `DefinedList` with
 * `enabled` defaulted to `true`.
 *
 * @throws if `id` is empty, malformed, or a reserved category id.
 */
export function defineList<const Id extends string>(meta: {
  id: Id;
  name: string;
  description?: string;
  defaultOptIn: boolean;
  enabled?: boolean;
}): DefinedList<Id> {
  const { id, name, description, defaultOptIn, enabled } = meta;

  if (!id || !LIST_ID_PATTERN.test(id)) {
    throw new Error(
      `Invalid list id "${id}": must match /^[a-z0-9_-]+$/i (letters, digits, "-", "_").`,
    );
  }

  if (isReservedListId(id)) {
    throw new Error(
      `Reserved list id "${id}": "transactional" and "journey" are built-in email-preference categories and cannot be used as list ids.`,
    );
  }

  const resolvedMeta: ListMeta<Id> = {
    id,
    name,
    ...(description !== undefined ? { description } : {}),
    defaultOptIn,
    enabled: enabled ?? true,
  };

  return {
    meta: resolvedMeta,
    id,
  };
}
