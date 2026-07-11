// @hogsend/sms — SMS template machinery only. No concrete templates are baked
// in here; clients own their `.tsx` templates + registry and augment the open
// `SmsTemplateRegistryMap` interface (module augmentation).

// Template registry
export {
  createSmsRegistry,
  getSmsPreviewText,
  getSmsTemplate,
  getSmsTemplateDefinition,
  getSmsTemplateNames,
  withSources,
} from "./registry.js";
// Rendering
export { renderSmsToText } from "./render.js";
// Segment counting
export type { SmsSegmentCount } from "./segments.js";
export { countSmsSegments } from "./segments.js";
// Types
export type {
  SmsRenderResult,
  SmsTemplateDefinition,
  SmsTemplateName,
  SmsTemplateRegistry,
  SmsTemplateRegistryMap,
} from "./types.js";
// Runtime values & error classes
export { SmsSendError } from "./types.js";
