// The `@hogsend/email` `TemplateName` — the union of keys THIS app has actually
// registered (registry.ts + the `templates.d.ts` augmentation). Aliased so it
// doesn't clash with the local `TemplateName` exported below. The
// `satisfies Record<string, RegisteredTemplateKey>` on `Templates` makes every
// value here a COMPILE error unless it is a registered key — so a journey can
// no longer reference an email that doesn't exist (e.g. a `activation/welcome`
// slash-key when the registry only has the `activation-quickstart` hyphen-key).
import type { TemplateName as RegisteredTemplateKey } from "@hogsend/email";

export const Templates = {
  // NOTE: keys map to the hyphen-keys REGISTERED in src/emails/registry.ts.
  // These were previously `activation/…` slash-keys that were never registered,
  // so every send silently failed to load at runtime — now a compile error.
  ACTIVATION_WELCOME: "activation-quickstart",
  ACTIVATION_ADVANCED: "activation-feature-highlight",
  ACTIVATION_NUDGE: "activation-nudge",
  ACTIVATION_COMMUNITY: "activation-community",
  ACTIVATION_NUDGE_SERIES: "activation-nudge",
  ACTIVATION_QUICKSTART: "activation-quickstart",
  ACTIVATION_FEATURE_HIGHLIGHT: "activation-feature-highlight",
  ACTIVATION_COMMUNITY_ALT: "activation-community",

  CONVERSION_USAGE_MILESTONE: "conversion-usage-milestone",
  CONVERSION_TRIAL_EXPIRING: "conversion-trial-expiring",
  CONVERSION_WINBACK_OFFER: "conversion-winback-offer",

  RETENTION_ACHIEVEMENT: "retention-achievement",
  RETENTION_WEEKLY_DIGEST: "retention-weekly-digest",

  ONBOARDING_PERSONALIZED: "onboarding-personalized",
  ONBOARDING_NUDGE: "onboarding-nudge",

  REENGAGE_TIP_A: "reengage-tip-a",
  REENGAGE_TIP_B: "reengage-tip-b",
  REENGAGE_WEBINAR: "reengage-webinar",

  REACTIVATION_CHECKIN: "reactivation-checkin",
  REACTIVATION_FINAL_NUDGE: "reactivation-final-nudge",

  FEEDBACK_NPS_SURVEY: "feedback-nps-survey",

  CHURN_PAYMENT_FAILED: "churn-payment-failed",

  // Transactional — one-off via hs.emails.send.
  TRANSACTIONAL_VERIFY_EMAIL: "transactional/verify-email",
  TRANSACTIONAL_MAGIC_LINK: "transactional/magic-link",
  TRANSACTIONAL_RECEIPT: "transactional/receipt",

  // Marketing — broadcast to a list via hs.campaigns.send.
  MARKETING_PRODUCT_UPDATE: "marketing/product-update",
} as const satisfies Record<string, RegisteredTemplateKey>;

export type TemplateName = (typeof Templates)[keyof typeof Templates];
