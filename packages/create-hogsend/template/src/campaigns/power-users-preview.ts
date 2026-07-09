import { defineCampaign } from "@hogsend/engine";

/**
 * Example bucket broadcast — an early-access note to every ACTIVE member of
 * the `power-users` bucket (see `src/buckets/power-users.ts`). CONTENT, yours
 * to edit.
 *
 * A bucket audience is behavioral: whoever is in the bucket AT SEND TIME gets
 * it — no list subscription involved (globally-unsubscribed and suppressed
 * contacts are still excluded). Ships `enabled: false`; flip it, set a real
 * `sendAt`, and deploy to arm it.
 */
export const powerUsersPreview = defineCampaign({
  id: "power-users-preview-example",
  name: "Early access for power users",
  audience: { bucket: "power-users" },
  template: "marketing/product-update",
  props: {
    headline: "You're in: early access to the new API",
    intro:
      "You're one of our heaviest users, so you get the new API a week before everyone else.",
    ctaUrl: "https://example.com/early-access",
    ctaText: "Get your key",
  },
  sendAt: "2030-01-08T16:00:00Z",
  enabled: false,
});
