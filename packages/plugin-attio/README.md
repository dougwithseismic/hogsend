# @hogsend/plugin-attio

Attio `CrmProvider` for Hogsend's revenue spine: person assert on lead push,
signed `record.*` webhooks hydrated through the REST API (Attio payloads are
thin), stage + currency-value extraction.

```ts
import { createAttioProvider } from "@hogsend/plugin-attio";

createHogsendClient({
  crm: {
    provider: createAttioProvider({
      apiKey: process.env.ATTIO_API_KEY!,
      webhookSecret: process.env.ATTIO_WEBHOOK_SECRET!,
    }),
    stageMaps: {
      attio: { "*": { "status-quote": "quoted", "status-sold": "sold" } },
    },
  },
});
```

Subscribe an Attio webhook (record.updated on your deal object) to
`POST https://<api>/v1/webhooks/crm/attio`. Verification is HMAC-SHA256 of
the raw body against `attio-signature`, fail-closed.

Status: built against docs.attio.com shapes with fixture tests; run a live
workspace pass before production. When `feat/sources-prospects-p1` (Attio
contact source + write-back) merges, fold the HTTP transport together.
