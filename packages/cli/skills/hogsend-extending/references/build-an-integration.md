# Building an integration

An integration is **something your journey calls out to** — Slack, a CRM, Stripe,
an internal HTTP API. It has **no contract** and the engine knows nothing about
it. The simplest integration is the best one: install the SDK, write a thin
wrapper, import it into a journey.

This is *not* a capability provider — don't implement an engine contract for it,
and don't put it on `ctx`. (For email/analytics, which the engine drives, see
`swap-a-provider.md`.)

## 1. Install the SDK

```bash
pnpm add @slack/web-api
```

## 2. Write a thin wrapper — fail at construction, not at import

```ts
// src/lib/slack.ts — your content
import { WebClient } from "@slack/web-api";

export interface SlackServiceConfig {
  token: string;
  defaultChannel?: string;
}

export function createSlackService(config: SlackServiceConfig) {
  if (!config.token) {
    throw new Error("SlackServiceConfig.token is required");
  }
  const client = new WebClient(config.token);

  return {
    async sendMessage(opts: { channel?: string; text: string }) {
      const channel = opts.channel ?? config.defaultChannel;
      if (!channel) throw new Error("No channel and no defaultChannel configured");
      try {
        const result = await client.chat.postMessage({ channel, text: opts.text });
        return { ts: result.ts, channel: result.channel };
      } catch (error) {
        // Don't swallow — let the journey's error handling mark the run failed.
        throw new Error(
          `Slack sendMessage failed for ${channel}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    },
  };
}
```

Top-level `process.env.X!` access throws on *import* (even in tests). Validate
inside the factory instead.

## 3. Use it in a journey — a function call, not `ctx`

```ts
// src/journeys/churn-alert.ts — your content
import { days } from "@hogsend/core";
import { defineJourney, sendEmail } from "@hogsend/engine";
import { createSlackService } from "../lib/slack.js";
import { Events, Templates } from "./constants/index.js";

const slack = createSlackService({
  token: process.env.SLACK_BOT_TOKEN ?? "",
  defaultChannel: "#lifecycle-alerts",
});

export const churnAlert = defineJourney({
  meta: { id: "churn-alert", name: "Churn alert", enabled: true, trigger: { event: Events.PAYMENT_FAILED } },
  run: async (user, ctx) => {
    await slack.sendMessage({ text: `Payment failed for ${user.email}.` });
    await sendEmail({ to: user.email, userId: user.id, template: Templates.CHURN_PAYMENT_FAILED, subject: "Your payment didn't go through" });
    await ctx.sleep({ duration: days(2) });
    // ...escalate if still failing
  },
});
```

`slack.sendMessage` and `sendEmail` are both plain imports — neither is on `ctx`.
That keeps the journey context focused on orchestration and avoids coupling
integrations to the engine.

## Conventions

- **Optional caching.** If your service fetches slow-changing data (like
  `@hogsend/plugin-posthog` does for person properties), accept an optional Redis
  client + TTL in config and cache there.
- **Need the DB?** Open a connection with `createDatabase()` from `@hogsend/db`
  against your `DATABASE_URL`, or query a client-track table you defined in
  `src/schema/`.
- **Cleanup?** Expose a `shutdown()` and call it from your `src/worker.ts`
  graceful-shutdown handler alongside `worker.stop()`.
- **Testing.** Test against a mocked SDK client — no real API calls. The bundled
  `packages/plugin-resend/src/__tests__/` show the pattern.

## Background jobs (Hatchet tasks)

Some integrations are better as durable background work than inline — a nightly
CRM sync, a heavy backfill, a fan-out import. Author them as Hatchet tasks in your
`src/workflows/` and register via `createWorker({ extraWorkflows })` (the option
is `extraWorkflows`, NOT `workflows`). They run on the same worker as your
journeys. For heavy backfills, use `runBatchedBackfill` from `@hogsend/engine`;
the scaffold ships a `src/workflows/backfill-example.ts` to copy. See the
`hogsend-webhooks-and-workflows` skill for the full pattern.

## What integrations are not

No manifest, no auto-discovery, no lifecycle hooks, no registration. You import
what you need, where you need it. Integrations live entirely in your content, and
the engine upgrades underneath them with `pnpm up`.
