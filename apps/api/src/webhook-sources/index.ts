import type { DefinedWebhookSource } from "@hogsend/engine";
import { leadFormSource } from "./lead-form.js";
import { posthogSource } from "./posthog.js";

/**
 * The webhook sources this app accepts at `POST /v1/webhooks/:sourceId`. Pass to
 * `createApp(container, { webhookSources })`. Edit freely — this is your content.
 */
export const webhookSources: DefinedWebhookSource[] = [
  leadFormSource,
  posthogSource,
];
