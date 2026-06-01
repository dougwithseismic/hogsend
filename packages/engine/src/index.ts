// @hogsend/engine — public API surface (the committed semver boundary).
//
// Content (journeys, webhook sources, workflows) is injected into these
// factories by client app code; the engine never imports content.

// Core helpers used by content journeys (days/hours/minutes, condition + journey
// types) so content can import everything from `@hogsend/engine`.
export * from "@hogsend/core";
export { JourneyRegistry } from "@hogsend/core/registry";
// --- Re-exports for content ---
// Schema/version helpers used by the boot guard and the /v1/health route.
export {
  getBundledMigrations,
  getClientSchemaVersion,
  getEngineSchemaVersion,
  getSchemaVersion,
  type JournalShape,
  type SchemaVersion,
} from "@hogsend/db";
// --- App / container / worker factories ---
export { type AppEnv, type CreateAppOptions, createApp } from "./app.js";
export {
  createHogsendClient,
  type HogsendClient,
  type HogsendClientOptions,
} from "./container.js";
// --- Env ---
export { API_VERSION, env } from "./env.js";
// --- Journeys ---
export {
  type DefinedJourney,
  defineJourney,
} from "./journeys/define-journey.js";
export { createJourneyContext } from "./journeys/journey-context.js";
export {
  buildJourneyRegistry,
  parseEnabledFilter,
  selectJourneyTasks,
} from "./journeys/registry.js";
export {
  getJourneyRegistrySingleton,
  setJourneyRegistry,
} from "./journeys/registry-singleton.js";
// --- Auth ---
export { type Auth, createAuth } from "./lib/auth.js";
// --- Backfill ---
export {
  type BatchedBackfillOptions,
  type BatchedBackfillResult,
  runBatchedBackfill,
} from "./lib/backfill.js";
// --- Infrastructure singletons ---
export { getDb } from "./lib/db.js";
// --- Email ---
export {
  type SendEmailOptions,
  type SendEmailResult,
  sendEmail,
  setEmailService,
} from "./lib/email.js";
// --- Email service (engine-owned tracked mailer) ---
export type {
  EmailService,
  EmailServiceConfig,
  EmailServiceSendOptions,
  EmailServiceWebhookOptions,
  EmailServiceWebhookResult,
  SendTrackedEmailOptions,
  TrackedSendResult,
} from "./lib/email-service-types.js";
// --- Enrollment guards ---
export { checkEmailPreferences } from "./lib/enrollment-guards.js";
export { hatchet } from "./lib/hatchet.js";
// --- Ingestion pipeline ---
export {
  type IngestEvent,
  type IngestResult,
  ingestEvent,
} from "./lib/ingestion.js";
// --- Logging ---
export { createLogger, type Logger } from "./lib/logger.js";
export { createTrackedMailer } from "./lib/mailer.js";
export { getPostHog } from "./lib/posthog.js";
export { getRedisIfConnected } from "./lib/redis.js";
export {
  type PrepareTrackedHtmlFn,
  sendTrackedEmail,
} from "./lib/tracked.js";
// --- Tracking ---
export {
  injectOpenPixel,
  prepareTrackedHtml,
  rewriteLinks,
} from "./lib/tracking.js";
export {
  pushTrackingEvent,
  resolveEmailSendContext,
} from "./lib/tracking-events.js";
// --- Webhook sources ---
export {
  type DefinedWebhookSource,
  defineWebhookSource,
  type WebhookSourceCtx,
  type WebhookSourceMeta,
} from "./webhook-sources/define-webhook-source.js";
export {
  type CreateWorkerOptions,
  createWorker,
  type Worker,
} from "./worker.js";
export { checkAlertsTask } from "./workflows/check-alerts.js";
export { importContactsTask } from "./workflows/import-contacts.js";
// --- Built-in Hatchet workflow tasks ---
export { sendEmailTask } from "./workflows/send-email.js";
