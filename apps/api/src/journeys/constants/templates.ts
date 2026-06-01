export const Templates = {
  ACTIVATION_WELCOME: "activation/welcome",
  ACTIVATION_ADVANCED: "activation/advanced",
  ACTIVATION_NUDGE: "activation/nudge",
  ACTIVATION_COMMUNITY: "activation/community",
  ACTIVATION_NUDGE_SERIES: "activation-nudge",
  ACTIVATION_QUICKSTART: "activation-quickstart",
  ACTIVATION_FEATURE_HIGHLIGHT: "activation-feature-highlight",
  ACTIVATION_COMMUNITY_ALT: "activation-community",

  CONVERSION_USAGE_MILESTONE: "conversion-usage-milestone",
  CONVERSION_TRIAL_EXPIRING: "conversion-trial-expiring",
  CONVERSION_WINBACK_OFFER: "conversion-winback-offer",

  RETENTION_ACHIEVEMENT: "retention-achievement",

  REACTIVATION_CHECKIN: "reactivation-checkin",
  REACTIVATION_FINAL_NUDGE: "reactivation-final-nudge",

  FEEDBACK_NPS_SURVEY: "feedback-nps-survey",

  CHURN_PAYMENT_FAILED: "churn-payment-failed",
} as const;

export type TemplateName = (typeof Templates)[keyof typeof Templates];
