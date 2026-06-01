import type { Database } from "@hogsend/db";
import type { z } from "zod";
import type { IngestEvent } from "../lib/ingestion.js";
import type { Logger } from "../lib/logger.js";

export interface WebhookSourceAuth {
  header: string;
  envKey: string;
  type: "match";
}

export interface WebhookSourceCtx {
  db: Database;
  logger: Logger;
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
