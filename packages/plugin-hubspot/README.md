# @hogsend/plugin-hubspot

HubSpot `CrmProvider` for Hogsend's revenue spine: contact search-then-create
on lead push, `deal.propertyChange` webhooks hydrated through the v3 API
(HubSpot payloads carry only the changed property), amount + currency + won
status extraction, `hs_lastmodifieddate` reconciliation poll.

```ts
import { createHubspotProvider } from "@hogsend/plugin-hubspot";

createHogsendClient({
  crm: {
    provider: createHubspotProvider({
      accessToken: process.env.HUBSPOT_PRIVATE_APP_TOKEN!,
      clientSecret: process.env.HUBSPOT_CLIENT_SECRET, // developer-app webhooks (v3 signature)
      // OR: webhookSecret for signature-less workflow webhooks
    }),
    stageMaps: {
      hubspot: { "*": { presentationscheduled: "quoted", closedwon: "sold" } },
    },
  },
});
```

Webhook verification is fail-closed: v3 signature (HMAC-SHA256 base64 over
method+uri+body+timestamp, ±5-minute window) when `clientSecret` is set, a
shared `?secret=`/`x-hubspot-secret` otherwise; unconfigured = rejected.

Status: built against HubSpot's published v3 shapes with fixture tests; run a
live sandbox pass before production (docs/revenue-attribution-plan.md §4.6).
