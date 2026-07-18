import { defineFlag } from "@hogsend/engine";

/**
 * Code-first feature flags (`defineFlag`) — the CONTRACT (key + served shape)
 * committed to the repo. Mirrors `defineJourney` / `defineCampaign`: write a
 * file, deploy, and the boot reconciler upserts each into a `flags` row. Every
 * flag is born DISABLED with rollout 0, so shipping this file never flips live
 * traffic — an operator turns it on and sets targeting/rollout in Studio (or
 * via the admin API), and the reconciler only syncs contract drift afterward,
 * never touching that operator-owned state.
 *
 * Code owns: key, name, type, variants, defaultValue, description.
 * DB/Studio owns: enabled (after create), rollout, targeting, conditionSets.
 *
 * After adding or removing a flag here, run `pnpm flags:generate` to refresh
 * `flags.d.ts` — that augmentation is what type-checks `useFlag()`
 * (@hogsend/react), `hogsend.getFlag()` (@hogsend/js), and
 * `client.flags.evaluate()` (@hogsend/client) against THIS app's flag keys.
 *
 * Dynamic (data-plane) flags created with `client.flags.create()` or in Studio
 * coexist unchanged — use those for experimental/short-lived flags, and
 * `defineFlag` for durable product flags you want reviewed in a PR.
 */

/**
 * Gates a not-yet-shipped preview banner. Boolean flag — a live-eval returns
 * `true` only once an operator enables it AND the contact falls in the rollout
 * slice. Ships born-off (contract only, no targeting/rollout in code).
 */
export const previewBanner = defineFlag({
  key: "preview-banner",
  name: "Preview banner",
  type: "boolean",
  description:
    "Shows an in-progress preview banner. Disabled until an operator rolls it out.",
});

export const flags = [previewBanner];
