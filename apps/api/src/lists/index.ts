import { defineList } from "@hogsend/engine";

/**
 * Code-defined email lists (D3) — named subscription categories layered on top
 * of `email_preferences.categories`. There is NO new table: a list is just a
 * category key with a declared default polarity (`defaultOptIn`).
 *
 * `defaultOptIn: false` (opt-in) means a contact is NOT subscribed until they
 * explicitly subscribe — the suppression check blocks unless `categories[id]`
 * is exactly `true`. `defaultOptIn: true` (opt-out, e.g. a default newsletter)
 * means they're subscribed unless they explicitly unsubscribe.
 *
 * Each list is passed to both `createHogsendClient({ lists })` (so the mailer's
 * suppression check + the preference center see it) and is reachable over the
 * data plane at `GET /v1/lists` + `POST /v1/lists/:id/(un)subscribe`.
 *
 * Edit freely — this is your content. Add a list, then re-thread the `lists`
 * array into `createHogsendClient` in `src/index.ts` and `src/worker.ts`.
 *
 * No `DefinedList[]` annotation: the base type re-widens each list's `id`
 * literal back to `string`. Letting the array infer keeps every member's
 * literal id. A `DefinedList<Id>` is still assignable to the base
 * `DefinedList[]` that the factories accept.
 */
export const productUpdates = defineList({
  id: "product-updates",
  name: "Product updates",
  description:
    "Occasional emails about new features, changes, and product news.",
  defaultOptIn: false,
});

/**
 * All defined lists for this app. Passed to `createHogsendClient({ lists })` in
 * both `src/index.ts` and `src/worker.ts`.
 */
export const lists = [productUpdates];
