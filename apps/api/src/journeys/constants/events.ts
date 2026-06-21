export const Events = {
  USER_CREATED: "user.created",
  USER_DELETED: "user.deleted",
  USER_ACTIVATED: "user.activated",
  USER_DORMANCY_DETECTED: "user.dormancy_detected",
  DORMANT_30D: "user.dormant_30d",
  USER_SUPPRESSED: "user.suppressed",

  FEATURE_USED: "feature.used",
  FEATURE_ACTIVATED: "feature.activated",
  KEY_ACTION: "key.action",
  APP_ACTIVE: "app.active",
  SETUP_COMPLETED: "setup.completed",
  VALUE_DELIVERED: "value.delivered",
  SESSION_COMPLETED: "session.completed",
  MILESTONE_REACHED: "milestone.reached",
  USAGE_MILESTONE_REACHED: "usage.milestone_reached",
  PAID_FEATURE_ATTEMPTED: "paid_feature.attempted",

  PAYMENT_FAILED: "payment.failed",
  PAYMENT_SUCCEEDED: "payment.succeeded",
  SUBSCRIPTION_CREATED: "subscription.created",
  SUBSCRIPTION_CANCELLED: "subscription.cancelled",
  CHECKOUT_ABANDONED: "checkout.abandoned",
  CHECKOUT_COMPLETED: "checkout.completed",

  NPS_SUBMITTED: "nps.submitted",
  NPS_DETRACTOR: "nps.detractor",

  TRIAL_STARTED: "trial.started",

  EMAIL_OPENED: "email.opened",
  EMAIL_LINK_CLICKED: "email.link_clicked",

  // Generic bucket-transition events (Section 4.5). Per-bucket aliases
  // (`bucket:entered:<id>` / `bucket:left:<id>`) are built with the id-validated
  // `bucketEntered`/`bucketLeft` helpers in `./buckets.js`.
  BUCKET_ENTERED: "bucket:entered",
  BUCKET_LEFT: "bucket:left",

  JOURNEY_WELCOME_FIRED: "journey.welcome_fired",
  JOURNEY_PRO_PATH: "journey.pro_path",
  JOURNEY_FREE_PATH: "journey.free_path",
  JOURNEY_COMPLETED: "journey.completed",

  TEST_SIGNUP: "test.signup",
} as const;

export type EventName = (typeof Events)[keyof typeof Events];
