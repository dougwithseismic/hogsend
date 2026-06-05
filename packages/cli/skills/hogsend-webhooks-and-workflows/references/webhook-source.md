# Reference: webhook sources (`defineWebhookSource`)

A webhook source turns an inbound HTTP request into an `IngestEvent`. Each source
is served by the engine at **`POST /v1/webhooks/{sourceId}`** and its output is
fed straight into `ingestEvent()` — so a webhook can store an event, push it to
Hatchet (routing it to matching journey tasks), evaluate journey exit conditions,
and upsert the contact.

You write the source files; the engine owns the route. Edit only
`src/webhook-sources/`.

## The shape you implement

`defineWebhookSource` is imported from `@hogsend/engine`. The definition object:

| Field | Type | Notes |
|-------|------|-------|
| `meta.id` | `string` | The `:sourceId` segment in the URL. Keep it URL-safe. |
| `meta.name` | `string` | Human label. |
| `meta.description?` | `string` | Optional. |
| `auth.header` | `string` | Request header carrying the shared secret. |
| `auth.envKey` | `string` | Env var holding the expected secret value. |
| `auth.type` | `"match"` | Only mode today: header value must equal the env value. |
| `schema?` | `z.ZodSchema<T>` | Optional Zod validator; on success `payload` is typed `T`. |
| `transform(payload, ctx)` | `=> Promise<IngestEvent \| null>` | Map payload → event. Return `null` to accept-and-skip. |

### Auth behaviour (important)

The route enforces auth **only when the env secret is set**. If
`process.env[auth.envKey]` is empty/undefined the source is treated as **open**
(no auth). When the secret is present, the request must send it either in
`auth.header` or as `Authorization: Bearer <secret>`; otherwise the route returns
`401`. Always set the env secret in any non-local environment.

### Validation

If you provide `schema`, the route runs `schema.safeParse(payload)` before
calling `transform`; a parse failure returns `400` and `transform` never runs.
Inside `transform`, `payload` is the parsed, typed value.

## The `transform` → `IngestEvent` contract

`transform(payload, ctx)` returns an `IngestEvent` (or `null`):

```ts
interface IngestEvent {
  event: string;                       // event name (this is what journeys trigger on)
  userId: string;                      // external/distinct id of the person
  userEmail: string;                   // "" if unknown — emptystring, not undefined
  properties: Record<string, unknown>; // event + person props; merged into the event
  idempotencyKey?: string;             // optional dedupe key (see below)
}
```

`ctx` is `{ db, logger }` — a Drizzle `Database` and the engine logger — for
lookups/diagnostics inside the transform. It does **not** carry `hatchet` or the
registry; those are applied by the route when it calls `ingestEvent`.

Notes that match the engine's behaviour:

- `event` is the routing key. Hatchet routes the pushed event to every journey
  whose trigger declares `onEvents: [thatEvent]`. The decision to *enroll* (or
  *exit*) is then made by trigger/exit conditions — see the **hogsend-conditions**
  skill.
- `userEmail` should be `""` when unknown (the ingestion pipeline treats a falsy
  email as "no email" for the contact upsert). Don't pass `undefined`.
- Only JSON-scalar properties (`string | number | boolean | null`) survive the
  push to Hatchet; nested objects/arrays are dropped from the event payload that
  reaches journey tasks (they're still stored on the `userEvents` row). Flatten
  anything a journey needs to branch on into a scalar property.
- `idempotencyKey` (optional): when set, a duplicate delivery with the same key is
  a no-op (`{ stored: false }`) — use the provider's event id when available.
- Return `null` to accept the delivery (HTTP `200 { ok: true, skipped: true }`)
  without ingesting — e.g. event types you don't care about.

## Example: a source from the scaffold

`src/webhook-sources/posthog.ts` — validates a PostHog destination payload and
maps it to an `IngestEvent`:

```ts
import { defineWebhookSource } from "@hogsend/engine";
import { z } from "zod";

const posthogWebhookSchema = z.object({
  event: z.object({
    uuid: z.string().optional(),
    event: z.string(),
    distinct_id: z.string(),
    properties: z.record(z.string(), z.unknown()).optional(),
  }),
  person: z
    .object({
      properties: z
        .object({ email: z.string().optional() })
        .catchall(z.unknown())
        .optional(),
    })
    .optional(),
});

export const posthogSource = defineWebhookSource({
  meta: {
    id: "posthog",
    name: "PostHog",
    description: "Receives events from PostHog webhook destinations.",
  },
  auth: {
    header: "x-posthog-webhook-secret",
    envKey: "POSTHOG_WEBHOOK_SECRET",
    type: "match",
  },
  schema: posthogWebhookSchema,
  async transform(payload) {
    const rawEmail = payload.person?.properties?.email;
    const userEmail = typeof rawEmail === "string" ? rawEmail : "";

    const properties: Record<string, unknown> = {
      ...payload.event.properties,
      ...payload.person?.properties,
    };
    if (payload.event.uuid) {
      properties._posthogEventId = payload.event.uuid;
    }

    return {
      event: payload.event.event,
      userId: payload.event.distinct_id,
      userEmail,
      properties,
    };
  },
});
```

## Wiring it up (two edits)

### 1. Register in `src/webhook-sources/index.ts`

```ts
import type { DefinedWebhookSource } from "@hogsend/engine";
import { posthogSource } from "./posthog.js";
import { stripeSource } from "./stripe.js"; // your new source

export const webhookSources: DefinedWebhookSource[] = [
  posthogSource,
  stripeSource,
];
```

### 2. Pass to `createApp` in `src/index.ts`

The scaffold already threads this — confirm it's present:

```ts
import { webhookSources } from "./webhook-sources/index.js";

const app = createApp(client, { webhookSources });
```

That's it. Your source is now live at `POST /v1/webhooks/stripe`.

## Authoring a new source — checklist

1. Create `src/webhook-sources/<id>.ts` exporting a `defineWebhookSource({...})`.
2. Pick a unique `meta.id` (becomes the URL segment).
3. Set `auth.envKey` and add that secret to your env for non-local deploys.
4. Add a Zod `schema` for the payload you expect (recommended).
5. In `transform`, produce `{ event, userId, userEmail, properties }` (or `null`).
   Flatten anything a journey will branch on into a scalar property.
6. Add the export to the `webhookSources` array in `index.ts`.
7. Verify deliveries land using the **hogsend-cli** skill (events/contacts).
