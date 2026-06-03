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

  // Generic bucket-transition events (emitted by the engine on any bucket
  // join/leave). Per-bucket aliases (`bucket:entered:<id>` / `bucket:left:<id>`)
  // are built with the id-validated `bucketEntered`/`bucketLeft` helpers below —
  // bind a journey's `trigger.event` to those, not these generic forms.
  BUCKET_ENTERED: "bucket:entered",
  BUCKET_LEFT: "bucket:left",

  // The smoke-test event the bundled test-onboarding journey listens for.
  TEST_SIGNUP: "test.signup",
} as const;

export type EventName = (typeof Events)[keyof typeof Events];

/**
 * The union of bucket ids registered in `src/buckets/index.ts`. Keep this in
 * sync with the `buckets` array (add an id here when you add a bucket) — it is
 * what makes the alias helpers below catch a typo at COMPILE time.
 *
 * `JourneyMeta.trigger.event` is typed `string`, so without this guard a journey
 * could bind to a misspelled `bucket:entered:<typo>` alias that silently never
 * fires. (`defineBucket` widens `meta.id` to `string`, so an array-derived
 * `(typeof buckets)[number]["meta"]["id"]` would collapse to `string` and lose
 * typo-safety — hence this explicit literal union, the source of truth.)
 */
export type BucketId = "power-users";

// Narrow-alias helpers — ONLY accept a registered BucketId, so a typo such as
// `bucketEntered("power-uesrs")` is a compile error rather than a silently
// never-firing trigger. The return type is the exact literal event name, so it
// drops straight into a journey's `trigger.event` / `exitOn` rule.
export const bucketEntered = <T extends BucketId>(id: T) =>
  `bucket:entered:${id}` as const;

export const bucketLeft = <T extends BucketId>(id: T) =>
  `bucket:left:${id}` as const;

export const Templates = {
  // Email template keys resolved by @hogsend/email's registry.
  ACTIVATION_WELCOME: "activation/welcome",
  ACTIVATION_NUDGE: "activation/nudge",
} as const;

export type TemplateName = (typeof Templates)[keyof typeof Templates];
