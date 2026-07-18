import { defineFlag } from "@hogsend/engine";

/**
 * Code-first feature flags (`defineFlag`) — the CONTRACT (key + served shape)
 * committed to the repo. The boot reconciler upserts each into a `flags` row:
 * born DISABLED with rollout 0, so shipping this file never flips live traffic.
 * An operator turns the flag on and sets targeting/rollout in Studio (or via
 * the admin API); the reconciler syncs only contract drift afterward and never
 * touches that operator state. Dynamic (data-plane) flags coexist unchanged.
 */

/**
 * Gates the "what's new" preview banner in the docs site. Boolean flag — a
 * live-eval returns `true` only once an operator enables it and the contact
 * falls in the rollout slice.
 */
export const docsPreviewBanner = defineFlag({
  key: "docs-preview-banner",
  name: "Docs preview banner",
  type: "boolean",
  description:
    "Shows the in-progress preview banner on hogsend.com/docs. Disabled until an operator rolls it out.",
});

export const flags = [docsPreviewBanner];
