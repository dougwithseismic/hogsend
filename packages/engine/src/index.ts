// @hogsend/engine — public API surface (the committed semver boundary).
//
// Content (journeys, webhook sources, workflows) is injected into these
// factories by client app code; the engine never imports content.

// Sending-domain capability contract (presence of `EmailProvider.domains` is
// the gate). Already covered by the `export * from "@hogsend/core"` above —
// re-named here for discoverability.
export type {
  BatchEmailItem,
  CaptureOptions,
  DnsRecord,
  DnsRecordPurpose,
  DnsRecordStatus,
  DomainStatus,
  DomainsCapability,
  DomainVerificationState,
  EmailEvent,
  EmailEventType,
  EmailProvider,
  EmailProviderCapabilities,
  EmailProviderMeta,
  /** @deprecated Use {@link EmailEvent}. Frozen `event.raw` cast target. */
  LegacyResendWebhookEvent,
  PostHogService,
  SendResult,
  /** @deprecated Use {@link EmailEvent}. Kept for one minor. */
  WebhookEvent,
  WebhookHandlerMap,
} from "@hogsend/core";
// Core helpers used by content journeys (days/hours/minutes, condition + journey
// types) so content can import everything from `@hogsend/engine`.
export * from "@hogsend/core";
// --- Capability-provider contracts (canonical origin: @hogsend/core) ---
// Email provider contract + analytics contract, re-exported so consumers can
// import them from `@hogsend/engine`. (`SendEmailOptions` is intentionally
// omitted here: the engine's public `SendEmailOptions` is the high-level
// journey-facing send options from `./lib/email.js`; the provider-contract
// `SendEmailOptions` remains available via `@hogsend/core`.)
export { defineEmailProvider, WebhookHandshakeSignal } from "@hogsend/core";
export {
  BucketRegistry,
  JourneyRegistry,
} from "@hogsend/core/registry";
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
// --- Buckets ---
export {
  type BucketAccessor,
  type BucketMemberRow,
  createBucketAccessor,
  type MembersResult,
} from "./buckets/bucket-access.js";
export type {
  BucketLeaveReason,
  DwellOptions,
  EnterOptions,
  LeaveOptions,
} from "./buckets/bucket-reactions.js";
export {
  type BucketTransition,
  type BucketTransitionKind,
  checkBucketMembership,
} from "./buckets/check-membership.js";
export {
  type DefinedBucket,
  defineBucket,
} from "./buckets/define-bucket.js";
export {
  buildBucketRegistry,
  collectBucketReactionJourneys,
  selectBucketReactionTasks,
  selectBucketTasks,
} from "./buckets/registry.js";
export {
  getBucketRegistrySingleton,
  resetBucketRegistry,
  setBucketRegistry,
} from "./buckets/registry-singleton.js";
export {
  createHogsendClient,
  type HogsendClient,
  type HogsendClientOptions,
  type HogsendDefaults,
} from "./container.js";
// --- Outbound destinations: public authoring layer (Phase 3) ---
export {
  type DefinedDestination,
  type DestinationCtx,
  type DestinationEnvelope,
  type DestinationMeta,
  type DestinationTransformResult,
  defineDestination,
  type WebhookEndpointRow,
} from "./destinations/define-destination.js";
export {
  type DestinationPresetId,
  destinationsFromEnv,
  PRESET_DESTINATIONS,
  posthogDestination,
  segmentDestination,
  slackDestination,
  webhookDestination,
} from "./destinations/presets/index.js";
export {
  DestinationRegistry,
  getDestinationRegistry,
  resetDestinationRegistry,
  setDestinationRegistry,
} from "./destinations/registry-singleton.js";
// --- Env ---
export { API_VERSION, env } from "./env.js";
// --- Journeys ---
export {
  type DefinedJourney,
  defineJourney,
} from "./journeys/define-journey.js";
export { JourneyExitedError } from "./journeys/errors.js";
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
export {
  type Auth,
  createAuth,
  type SendResetPasswordFn,
} from "./lib/auth.js";
// --- Backfill ---
export {
  type BatchedBackfillOptions,
  type BatchedBackfillResult,
  runBatchedBackfill,
} from "./lib/backfill.js";
// --- Boot output (engine-owned startup banner / structured ready log) ---
export {
  type ApiReadyInfo,
  getEngineVersion,
  reportApiReady,
  reportWorkerReady,
  type WorkerReadyInfo,
} from "./lib/boot.js";
// --- First-admin creation (CLI + boot bootstrap share this scrypt-correct path)
export { bootstrapAdminFromEnv } from "./lib/bootstrap-admin.js";
// --- Bucket transition emission (shared by real-time / cron / fast-expiry) ---
export {
  type BucketTransitionSource,
  emitBucketTransition,
} from "./lib/bucket-emit.js";
export {
  AdminAlreadyExistsError,
  type CreatedAdmin,
  createAdminUser,
} from "./lib/create-admin.js";
// --- Infrastructure singletons ---
export { getDb } from "./lib/db.js";
// --- Sending-domain status service (cached; container-held) ---
export {
  createDomainStatusService,
  type DomainStatusService,
  type EngineDomainStatus,
  type TestModeState,
} from "./lib/domain-status.js";
// --- Email ---
export {
  type SendEmailOptions,
  type SendEmailResult,
  sendEmail,
  setEmailService,
} from "./lib/email.js";
// --- Email provider registry (container-held, keyed by meta.id) ---
export { EmailProviderRegistry } from "./lib/email-provider-registry.js";
// --- Email service (engine-owned tracked mailer) ---
export type {
  EmailService,
  EmailServiceConfig,
  EmailServiceSendOptions,
  EmailServiceWebhookOptions,
  EmailServiceWebhookResult,
  FrequencyCapConfig,
  FrequencyCapWindow,
  SendTrackedEmailOptions,
  TrackedSendResult,
} from "./lib/email-service-types.js";
// --- Enrollment guards ---
export { checkEmailPreferences } from "./lib/enrollment-guards.js";
export { isFrequencyCapped } from "./lib/frequency-cap.js";
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
// --- Outbound webhooks: emit spine (Section 1.4) ---
export {
  emitOutbound,
  OUTBOUND_EVENTS,
  type OutboundEventName,
  type OutboundPayloads,
} from "./lib/outbound.js";
export { getPostHog } from "./lib/posthog.js";
export {
  type AuthSecondaryStorage,
  createRedisSecondaryStorage,
  getRedisIfConnected,
} from "./lib/redis.js";
// --- Self-service password reset (engine-owned, self-contained email) ---
export { sendResetPasswordEmail } from "./lib/reset-email.js";
export { type MountStudioResult, mountStudio } from "./lib/studio.js";
export {
  type ResolveTimezoneInput,
  type ResolveTimezoneResult,
  resolveTimezone,
  resolveTimezoneWithSource,
  setContactTimezone,
  type TimezoneSource,
} from "./lib/timezone.js";
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
  resolveEmailSendContextByMessageId,
  /**
   * @deprecated Kept for one minor; use
   * {@link resolveEmailSendContextByMessageId}.
   */
  resolveEmailSendContextByResendId,
} from "./lib/tracking-events.js";
// --- Outbound webhooks: signing core (Section 1.2) ---
export {
  generateWebhookSecret,
  type SignedWebhook,
  signWebhook,
  verifyWebhookSignature,
  WEBHOOK_EVENT_TYPES,
  type WebhookEventType,
} from "./lib/webhook-signing.js";
// --- Lists (D3) ---
export {
  type DefinedList,
  defineList,
  type ListMeta,
} from "./lists/define-list.js";
export { buildListRegistry, ListRegistry } from "./lists/registry.js";
export {
  getListRegistry,
  resetListRegistry,
  setListRegistry,
} from "./lists/registry-singleton.js";
// --- Webhook sources ---
export {
  type DefinedWebhookSource,
  defineWebhookSource,
  verifySignature,
  type WebhookSourceAuth,
  type WebhookSourceCtx,
  type WebhookSourceMeta,
} from "./webhook-sources/define-webhook-source.js";
// --- Integration presets (Section 2.3/2.4) ---
export {
  clerkSource,
  PRESET_SOURCES,
  type PresetId,
  presetsFromEnv,
  segmentSource,
  stripeSource,
  supabaseSource,
} from "./webhook-sources/presets/index.js";
export {
  type CreateWorkerOptions,
  createWorker,
  type Worker,
} from "./worker.js";
export {
  type BucketBackfillInput,
  bucketBackfillTask,
  computeCriteriaHash,
  enqueueBucketBackfills,
} from "./workflows/bucket-backfill.js";
export {
  type BucketArmExpiryInput,
  bucketExpiryTask,
  bucketReconcileTask,
} from "./workflows/bucket-reconcile.js";
export { checkAlertsTask } from "./workflows/check-alerts.js";
// --- Outbound webhooks: durable delivery task + reaper (Section 1.5) ---
export {
  deliverWebhookTask,
  reapDueWebhookDeliveriesTask,
} from "./workflows/deliver-webhook.js";
export { importContactsTask } from "./workflows/import-contacts.js";
export { sendCampaignTask } from "./workflows/send-campaign.js";
// --- Built-in Hatchet workflow tasks ---
export { sendEmailTask } from "./workflows/send-email.js";
