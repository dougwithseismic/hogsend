import type { Database } from "@hogsend/db";
import type { z } from "zod";
import type { IngestEvent } from "../lib/ingestion.js";
import type { Logger } from "../lib/logger.js";
import type { SignatureScheme, VerifySignatureArgs } from "./verify.js";

/**
 * How a webhook source authenticates inbound requests.
 *
 * A discriminated union on `type`:
 *
 *  - `"match"` — plain shared-secret equality. The route compares a configured
 *    secret against the request header (or `Authorization: Bearer`). When the
 *    secret is UNSET the source stays OPEN (parity with the pre-engine route);
 *    this variant is unchanged so PostHog + all consumer sources keep compiling.
 *
 *  - `"signature"` — provider HMAC signature verification (Svix / Stripe /
 *    generic hex HMAC). The route resolves the secret from `env[envKey]`, reads
 *    the EXACT raw request body, and calls `verifySignature` (or the optional
 *    per-source `verify` override) over those bytes. Signature sources FAIL
 *    CLOSED (401) when their secret is unset — they are security-sensitive.
 */
export type WebhookSourceAuth =
  | {
      type: "match";
      header: string;
      envKey: string;
    }
  | {
      type: "signature";
      scheme: SignatureScheme;
      envKey: string;
      header: string;
      /**
       * For schemes (notably `"svix"`) whose providers may also send a plain
       * shared-secret header: when the scheme's signature headers are absent but
       * this header matches the secret verbatim, accept the request. Lets
       * Supabase's `x-supabase-webhook-secret` plain-secret mode coexist with
       * its Svix mode.
       */
      fallbackMatchHeader?: string;
      /**
       * Optional per-source override of the built-in scheme verification. When
       * provided, the route calls this INSTEAD of `verifySignature(scheme, …)`.
       * Receives the EXACT received bytes; must return (or resolve to) a boolean.
       */
      verify?(args: VerifySignatureArgs): boolean | Promise<boolean>;
    };

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

export function defineWebhookSource<T>(
  def: DefinedWebhookSource<T>,
): DefinedWebhookSource<T> {
  return def;
}

export {
  type SignatureScheme,
  type VerifySignatureArgs,
  verifySignature,
} from "./verify.js";
