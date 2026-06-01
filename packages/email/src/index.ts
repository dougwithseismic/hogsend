// @hogsend/email — email machinery only. No concrete business templates are
// baked in here; clients own their `.tsx` templates + registry and augment the
// open `TemplateRegistryMap` interface (Option B).

// Template registry
export {
  createRegistry,
  getPreviewText,
  getTemplate,
  getTemplateDefinition,
  getTemplateNames,
} from "./registry.js";

// Rendering
export { renderToHtml, renderToPlainText } from "./render.js";

// Types
export type {
  EmailServiceRenderOptions,
  EmailServiceRenderResult,
  RetryOptions,
  TemplateDefinition,
  TemplateName,
  TemplateRegistry,
  TemplateRegistryMap,
} from "./types.js";

// Runtime values & error classes
export {
  DEFAULT_RETRY_OPTIONS,
  EmailSendError,
  EmailSuppressionError,
  WebhookVerificationError,
} from "./types.js";

// Unsubscribe tokens
export type {
  TokenAction,
  TokenOptions,
  UnsubscribeTokenPayload,
} from "./unsubscribe-tokens.js";
export {
  generateUnsubscribeToken,
  InvalidTokenError,
  validateUnsubscribeToken,
} from "./unsubscribe-tokens.js";

// Unsubscribe URLs
export type { UnsubscribeUrlOptions } from "./unsubscribe-url.js";
export {
  generatePreferenceCenterUrl,
  generateUnsubscribeUrl,
} from "./unsubscribe-url.js";
