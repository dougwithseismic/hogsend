/**
 * Event + template name constants. Using typed `as const` objects instead of
 * magic strings keeps journey triggers / sends consistent and refactor-safe.
 * Add your own events and template keys here as you build journeys.
 */

export const Events = {
  // Lifecycle events your product emits (sent via POST /v1/ingest).
  USER_CREATED: "user.created",
  USER_DELETED: "user.deleted",
  FEATURE_USED: "feature.used",

  // Built-in journey lifecycle events (emitted by the engine).
  JOURNEY_WELCOME_FIRED: "journey.welcome_fired",
  JOURNEY_PRO_PATH: "journey.pro_path",
  JOURNEY_FREE_PATH: "journey.free_path",
  JOURNEY_COMPLETED: "journey.completed",

  // The smoke-test event the bundled test-onboarding journey listens for.
  TEST_SIGNUP: "test.signup",
} as const;

export type EventName = (typeof Events)[keyof typeof Events];

export const Templates = {
  // Email template keys resolved by @hogsend/email's registry.
  ACTIVATION_WELCOME: "activation/welcome",
  ACTIVATION_NUDGE: "activation/nudge",
} as const;

export type TemplateName = (typeof Templates)[keyof typeof Templates];
