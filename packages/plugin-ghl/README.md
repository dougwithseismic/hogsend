# @hogsend/plugin-ghl

GoHighLevel `CrmProvider` for Hogsend's revenue spine: lead push (contact
upsert + opportunity create), pipeline stage-change webhooks (value in the
payload), reconciliation poll, and hydrate.

```ts
import { createGhlProvider } from "@hogsend/plugin-ghl";

createHogsendClient({
  crm: {
    provider: createGhlProvider({
      accessToken: process.env.GHL_PIT_TOKEN!,
      locationId: process.env.GHL_LOCATION_ID!,
      webhookSecret: process.env.GHL_WEBHOOK_SECRET!,
      defaultPipelineId: "…",
    }),
    stageMaps: {
      ghl: {
        "*": {
          "stage-id-quote-sent": "quoted",
          "stage-id-closed-won": "sold",
        },
      },
    },
  },
});
```

Point a GHL workflow webhook at
`POST https://<api>/v1/webhooks/crm/ghl?secret=<GHL_WEBHOOK_SECRET>` on
opportunity stage changes. GHL workflow webhooks are unsigned, so the shared
secret is REQUIRED — the provider fails closed without it.

Status: built against GHL's published v2 API shapes with fixture tests; run a
live sandbox pass before production (see docs/revenue-attribution-plan.md §4.4).
