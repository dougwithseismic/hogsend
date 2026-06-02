import type { ReactElement } from "react";

// ---------------------------------------------------------------------------
// Template registry (open, augmentable — Option B "module augmentation")
// ---------------------------------------------------------------------------

/**
 * The set of template keys known to the type system, and the props each key
 * expects. This interface ships EMPTY: `@hogsend/email` bakes in no concrete
 * business templates. Client apps declare their templates by augmenting it:
 *
 * ```ts
 * declare module "@hogsend/email" {
 *   interface TemplateRegistryMap {
 *     welcome: { name: string; dashboardUrl?: string };
 *   }
 * }
 * ```
 *
 * After augmentation, `TemplateName` resolves to the client's keys and
 * `emailService.send({ template, props })` is fully type-checked.
 */
// biome-ignore lint/suspicious/noEmptyInterface: intentionally open for client augmentation
export interface TemplateRegistryMap {}

export type TemplateName = keyof TemplateRegistryMap;

export interface TemplateDefinition<P = Record<string, unknown>> {
  component: (props: P) => ReactElement;
  defaultSubject: string;
  category?: string;
  preview?: (props: P) => string;
  /**
   * Sample props used to render this template in admin previews / catalogs.
   * Purely illustrative — never used at real send time. Optional and additive;
   * a template without `examples` simply falls back to engine-injected defaults
   * (and its own component prop defaults) when previewed.
   */
  examples?: Partial<P>;
}

export type TemplateRegistry = {
  [K in TemplateName]: TemplateDefinition<TemplateRegistryMap[K]>;
};

// ---------------------------------------------------------------------------
// Render options
// ---------------------------------------------------------------------------

export interface EmailServiceRenderOptions<
  K extends TemplateName = TemplateName,
> {
  template: K;
  props: TemplateRegistryMap[K];
}

export interface EmailServiceRenderResult {
  html: string;
  text: string;
  subject: string;
  category?: string;
}

// ---------------------------------------------------------------------------
// Retry configuration
// ---------------------------------------------------------------------------

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export const DEFAULT_RETRY_OPTIONS: Required<RetryOptions> = {
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class EmailSendError extends Error {
  readonly retryable: boolean;
  readonly statusCode?: number;

  constructor(
    message: string,
    options: { retryable: boolean; statusCode?: number; cause?: unknown },
  ) {
    super(message, { cause: options.cause });
    this.name = "EmailSendError";
    this.retryable = options.retryable;
    this.statusCode = options.statusCode;
  }
}

export class EmailSuppressionError extends Error {
  readonly reason: "unsubscribed" | "suppressed" | "category_unsubscribed";

  constructor(reason: EmailSuppressionError["reason"], email: string) {
    super(`Email to ${email} suppressed: ${reason}`);
    this.name = "EmailSuppressionError";
    this.reason = reason;
  }
}

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}
