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

  // Billing lifecycle — drives the bundled `trial-expiring` journey. Emit
  // `trial.started` from your signup/billing code (e.g. `hs.events.send`); the
  // journey waits out the trial and emails before it ends. `subscription.started`
  // pulls a user OUT (they converted) so the reminder never fires.
  TRIAL_STARTED: "trial.started",
  SUBSCRIPTION_STARTED: "subscription.started",

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
 *
 * @deprecated Prefer the per-bucket typed refs `bucket.entered` / `bucket.left`
 * (e.g. `powerUsers.entered`), which are literal-typed off the bucket's own id
 * and need no hand-maintained union. Kept for one release for back-compat.
 */
export type BucketId = "power-users";

// Narrow-alias helpers — ONLY accept a registered BucketId, so a typo such as
// `bucketEntered("power-uesrs")` is a compile error rather than a silently
// never-firing trigger. The return type is the exact literal event name, so it
// drops straight into a journey's `trigger.event` / `exitOn` rule.
/**
 * @deprecated Use the typed ref `bucket.entered` (e.g. `powerUsers.entered`).
 * For binding to ANY bucket use the generic `Events.BUCKET_ENTERED` constant.
 */
export const bucketEntered = <T extends BucketId>(id: T) =>
  `bucket:entered:${id}` as const;

/**
 * @deprecated Use the typed ref `bucket.left` (e.g. `powerUsers.left`).
 * For binding to ANY bucket use the generic `Events.BUCKET_LEFT` constant.
 */
export const bucketLeft = <T extends BucketId>(id: T) =>
  `bucket:left:${id}` as const;

export const Templates = {
  // Email template keys resolved by @hogsend/email's registry.
  ACTIVATION_WELCOME: "activation/welcome",
  ACTIVATION_NUDGE: "activation/nudge",

  // Transactional — sent one-off via hs.emails.send.
  TRANSACTIONAL_MAGIC_LINK: "transactional/magic-link",
  TRANSACTIONAL_RECEIPT: "transactional/receipt",

  // Lifecycle — sent from journeys.
  LIFECYCLE_TRIAL_EXPIRING: "lifecycle/trial-expiring",

  // Marketing — broadcast to a list via hs.campaigns.send.
  MARKETING_PRODUCT_UPDATE: "marketing/product-update",
} as const;

export type TemplateName = (typeof Templates)[keyof typeof Templates];
