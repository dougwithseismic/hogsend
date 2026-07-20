import { defineConversion } from "@hogsend/engine";

/**
 * Conversion points — WHICH events
 * count as valued conversions for this deployment. Code-first content, like
 * journeys. Fired instances land in the `conversions` table; add destination
 * ids (e.g. `destinations: ["meta-capi"]` with a configured
 * `createMetaCapiDestination`) to feed ad platforms.
 */

/** A CRM deal closing — the primary revenue conversion. */
export const dealSold = defineConversion({
  id: "deal-sold",
  name: "Deal sold",
  trigger: { event: "deal.sold" },
  // Defaults: value = the event's first-class value; sources = server-side
  // only (browser events can't forge revenue).
});

/** A quote issued — the mid-funnel money signal (SOS-style cost-per-quote). */
export const dealQuoted = defineConversion({
  id: "deal-quoted",
  name: "Deal quoted",
  trigger: { event: "deal.quoted" },
});

/** A qualified lead arriving through any form vendor (docs/lead-intake.md). */
export const leadSubmitted = defineConversion({
  id: "lead-submitted",
  name: "Lead submitted",
  trigger: { event: "lead.submitted" },
});

export const conversions = [dealSold, dealQuoted, leadSubmitted];
