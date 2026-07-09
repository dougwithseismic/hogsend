import { defineCampaign } from "@hogsend/engine";

/**
 * Example broadcast — a scheduled product announcement to everyone subscribed
 * to the `product-updates` list (see `src/lists/index.ts`). CONTENT, yours to
 * edit.
 *
 * Ships `enabled: false` so a fresh deploy never sends it. To use it: write
 * your copy, set a real future `sendAt`, flip `enabled` to `true`, and deploy.
 * The worker's boot reconciler schedules it; once sent it is retired (keyed by
 * `id`, so redeploys never re-send). Cancel any time before the send with
 * `hogsend campaigns cancel <id>` or from Studio.
 */
export const productLaunch = defineCampaign({
  id: "product-launch-example",
  name: "Product launch announcement",
  audience: { list: "product-updates" },
  template: "marketing/product-update",
  props: {
    headline: "Saved views are here",
    intro: "A few things we shipped this month that we think you'll like.",
    highlights: [
      "Saved views — pin the filters you use every day",
      "CSV export on every table",
      "2x faster dashboard loads",
    ],
    ctaUrl: "https://example.com/changelog",
    ctaText: "Read the changelog",
  },
  sendAt: "2030-01-15T16:00:00Z",
  enabled: false,
});
