import type { DefinedWebhookSource } from "./define-webhook-source.js";
import { posthogSource } from "./posthog.js";

const allSources: DefinedWebhookSource[] = [posthogSource];

const sourceMap = new Map(allSources.map((s) => [s.meta.id, s]));

export function getWebhookSources(): Map<string, DefinedWebhookSource> {
  return sourceMap;
}

export type {
  DefinedWebhookSource,
  WebhookSourceAuth,
  WebhookSourceCtx,
  WebhookSourceMeta,
} from "./define-webhook-source.js";
export { defineWebhookSource } from "./define-webhook-source.js";
