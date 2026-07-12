# @hogsend/plugin-meta-capi

Meta Conversions API `ConversionDestination` for Hogsend's revenue spine:
one `system_generated` server event per fired conversion point, with the
engine's deterministic `event_id` (retry- and pixel-dedup-safe), `fbc`
reconstructed from the stored click timestamp, and SHA-256-hashed
identifiers.

```ts
import { createMetaCapiDestination } from "@hogsend/plugin-meta-capi";

createHogsendClient({
  conversions: [
    defineConversion({
      id: "solar-sale",
      trigger: { event: "crm.deal_sold" },
      destinations: ["meta-capi"],
    }),
  ],
  conversionDestinations: [
    createMetaCapiDestination({
      pixelId: process.env.META_PIXEL_ID!,
      accessToken: process.env.META_CAPI_TOKEN!,
      eventNames: { "solar-sale": "Purchase" },
    }),
  ],
});
```

For the Conversion Leads performance goal, name funnel-stage definitions to
match the stages you configure in Events Manager's Leads Funnel, and keep the
optimized stage's conversion rate between 1–40% (docs: plan §5.0 findings).

Status: fixture-tested; a live pass with a pixel + Test Events code is the
seam ask before production.
