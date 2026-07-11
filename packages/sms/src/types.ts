import type { ReactElement } from "react";

// ---------------------------------------------------------------------------
// SMS template registry (open, augmentable — module augmentation)
// ---------------------------------------------------------------------------

/**
 * The set of SMS template keys known to the type system, and the props each key
 * expects. Ships EMPTY — `@hogsend/sms` bakes in no concrete templates. Client
 * apps declare theirs by augmenting it:
 *
 * ```ts
 * declare module "@hogsend/sms" {
 *   interface SmsTemplateRegistryMap {
 *     "welcome-sms": { name: string };
 *   }
 * }
 * ```
 *
 * After augmentation, `SmsTemplateName` resolves to the client's keys and
 * `sendSms({ template, props })` is fully type-checked. This is a SEPARATE
 * namespace from `@hogsend/email`'s `TemplateRegistryMap` — SMS keys must not be
 * sendable through the email service and vice versa.
 */
// biome-ignore lint/suspicious/noEmptyInterface: intentionally open for client augmentation
export interface SmsTemplateRegistryMap {}

export type SmsTemplateName = keyof SmsTemplateRegistryMap;

export interface SmsTemplateDefinition<P = Record<string, unknown>> {
  component: (props: P) => ReactElement;
  /**
   * Optional list category (a topic id, `"transactional"`, or `"journey"`).
   * Drives the SMS preference/suppression gate. SMS has no subject line, so
   * there is no `defaultSubject` (unlike the email `TemplateDefinition`).
   */
  category?: string;
  /** One-line preview text for admin catalogs. */
  preview?: (props: P) => string;
  /** Sample props for admin previews. Illustrative — never used at send time. */
  examples?: Partial<P>;
  /** Best-effort absolute source path for a Studio "open in editor" affordance. */
  sourcePath?: string;
}

export type SmsTemplateRegistry = {
  [K in SmsTemplateName]: SmsTemplateDefinition<SmsTemplateRegistryMap[K]>;
};

// ---------------------------------------------------------------------------
// Render options
// ---------------------------------------------------------------------------

export interface SmsRenderResult {
  text: string;
  category?: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** SMS sibling of `EmailSendError` — classifies a provider send failure. */
export class SmsSendError extends Error {
  readonly retryable: boolean;
  readonly statusCode?: number;

  constructor(
    message: string,
    options: { retryable: boolean; statusCode?: number; cause?: unknown },
  ) {
    super(message, { cause: options.cause });
    this.name = "SmsSendError";
    this.retryable = options.retryable;
    this.statusCode = options.statusCode;
  }
}
