import type { Database } from "@hogsend/db";
import type { z } from "zod";
import {
  type ConnectorCtx,
  type DefinedConnector,
  defineConnector,
  type InboundVerifyAuth,
} from "../connectors/define-connector.js";
import type { IngestEvent } from "../lib/ingestion.js";
import type { Logger } from "../lib/logger.js";

/**
 * @deprecated naming only — `defineWebhookSource` is now the
 * `transport: "webhook"` specialization of {@link defineConnector}, kept as a
 * behavior- and signature-identical alias. NO migration is required.
 *
 * `WebhookSourceAuth` is an alias of the connector's inbound-verify union —
 * IDENTICAL shape today, so every existing source's `auth` keeps type-checking.
 *
 * SURFACE PIN: this alias must stay byte-for-byte equal to the frozen
 * `{ match | signature }` webhook auth shape. `__tests__/connectors.test.ts`
 * has a type-level assertion (`expectTypeOf<WebhookSourceAuth>()...`) that fails
 * the build if `InboundVerifyAuth` ever gains a third variant — so a future
 * additive change to the connector union can never silently widen this frozen
 * public webhook-source surface.
 */
export type WebhookSourceAuth = InboundVerifyAuth;

/**
 * Unchanged public shape. `ctx` stays the narrow webhook-only context —
 * `ConnectorCtx` minus `transport` — so consumer transforms typed against this
 * are byte-for-byte source-compatible.
 */
export interface WebhookSourceCtx {
  db: Database;
  logger: Logger;
  /**
   * The EXACT raw request body bytes (text), populated by the route. Required by
   * signature schemes (the signature covers these bytes) and available to any
   * `transform()` that needs provider-specific raw access.
   */
  rawBody?: string;
  /** The inbound request headers (lowercased keys), populated by the route. */
  headers?: Record<string, string>;
}

export interface WebhookSourceMeta {
  id: string;
  name: string;
  description?: string;
}

export interface DefinedWebhookSource<T = unknown> {
  meta: WebhookSourceMeta;
  auth: WebhookSourceAuth;
  schema?: z.ZodSchema<T>;
  transform(payload: T, ctx: WebhookSourceCtx): Promise<IngestEvent | null>;
}

/**
 * Lift a `DefinedWebhookSource` onto the connector umbrella as a
 * `transport: "webhook"` connector: `auth` → `inboundVerify`, transform `ctx`
 * widened to {@link ConnectorCtx} (the webhook route always sets
 * `transport: "webhook"` + `rawBody`/`headers`). Used by the container to
 * register webhook sources into the unified {@link ConnectorRegistry}.
 */
export function webhookSourceToConnector<T>(
  source: DefinedWebhookSource<T>,
): DefinedConnector<T> {
  return defineConnector<T>({
    meta: { ...source.meta, transport: "webhook" },
    inboundVerify: source.auth,
    schema: source.schema,
    transform: (payload: T, ctx: ConnectorCtx) =>
      source.transform(payload, ctx),
  });
}

export function defineWebhookSource<T>(
  def: DefinedWebhookSource<T>,
): DefinedWebhookSource<T> {
  // Unchanged contract: returns its argument. The container converts it via
  // webhookSourceToConnector when building the registry.
  return def;
}

export {
  type SignatureScheme,
  type VerifySignatureArgs,
  verifySignature,
} from "./verify.js";
