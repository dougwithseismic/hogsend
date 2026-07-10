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
export {
  defineAnalyticsProvider,
  defineEmailProvider,
  WebhookHandshakeSignal,
} from "@hogsend/core";
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
export {
  type AppEnv,
  type CreateAppOptions,
  createApp,
  type RoutesFn,
} from "./app.js";
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
// --- Campaigns (one-shot broadcasts) ---
export {
  type CampaignAudience,
  type CampaignMeta,
  DEFINED_CAMPAIGN_KEY_PREFIX,
  type DefinedCampaign,
  defineCampaign,
} from "./campaigns/define-campaign.js";
export {
  type ReconcileResult,
  reconcileDefinedCampaigns,
} from "./campaigns/reconcile.js";
// --- Cold-connect (email-confirmed chat-platform contact linking) ---
export {
  type ColdConnect,
  type ColdConnectBinding,
  type ColdConnectBranding,
  type ColdConnectConfig,
  createColdConnect,
} from "./cold-connect/index.js";
export {
  ConnectorActionRegistry,
  getConnectorActionRegistry,
  resetConnectorActionRegistry,
  setConnectorActionRegistry,
} from "./connectors/action-registry-singleton.js";
export {
  type ConnectorActionCtx,
  type DefinedConnectorAction,
  defineConnectorAction,
  type ResolvedActionContact,
} from "./connectors/define-action.js";
// --- Inbound connectors: unified authoring layer ---
export {
  type ConnectorCtx,
  type ConnectorHandlers,
  type ConnectorInteractionResult,
  type ConnectorMeta,
  type ConnectorOAuthResult,
  type ConnectorRouteCtx,
  type ConnectorTransport,
  type DefinedConnector,
  defineConnector,
  type InboundVerifyAuth,
  type StoredCredentialRef,
} from "./connectors/define-connector.js";
export {
  connectorsFromEnv,
  PRESET_CONNECTORS,
} from "./connectors/presets/index.js";
export {
  ConnectorRegistry,
  getConnectorRegistry,
  resetConnectorRegistry,
  setConnectorRegistry,
} from "./connectors/registry-singleton.js";
export {
  type ConnectorRuntime,
  type ConnectorRuntimeDeps,
  type ConnectorRuntimeFactory,
  type ConnectorRuntimesHandle,
  startConnectorRuntimes,
} from "./connectors/runtime.js";
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
  insertEnrollment,
  type JourneyStateRow,
} from "./journeys/define-journey.js";
export { JourneyExitedError } from "./journeys/errors.js";
// --- Journey graph extractor (Studio visual workflow) ---
export {
  buildJourneyGraph,
  degradedGraphFromMeta,
} from "./journeys/graph/build-graph.js";
export {
  createMemoize,
  deriveJourneyKey,
  getJourneyBoundary,
  type JourneyBoundary,
  parseJourneySendSite,
  registerKey,
  registerRecordLabel,
  runWithJourneyBoundary,
} from "./journeys/journey-boundary.js";
export { createJourneyContext } from "./journeys/journey-context.js";
// --- Journey transition log (journey_logs writer — Phase 2 per-stage metrics) ---
export {
  type JourneyLogAction,
  type LogTransitionArgs,
  logTransition,
} from "./journeys/journey-log.js";
export {
  getJourneySourceLocations,
  resetJourneySourceLocations,
  setJourneySourceLocations,
} from "./journeys/journey-source-locations-singleton.js";
export {
  getJourneySources,
  resetJourneySources,
  setJourneySources,
} from "./journeys/journey-sources-singleton.js";
export {
  peekRecord,
  type RecordNamespace,
  recordOnce,
} from "./journeys/record-once.js";
export {
  buildJourneyRegistry,
  parseEnabledFilter,
  resolveEnabledFilter,
  selectJourneyTasks,
} from "./journeys/registry.js";
export {
  getJourneyRegistrySingleton,
  setJourneyRegistry,
} from "./journeys/registry-singleton.js";
// --- Studio co-working agent (HITL proposal chokepoint) ---
export {
  InvalidProposalError,
  mintProposal,
  type ProposalPayload,
  type VerifiedProposal,
  verifyAndBurnProposal,
} from "./lib/agent/proposals.js";
// --- Analytics provider registry (the analytics sibling) ---
export {
  type IdentityMergeReason,
  logResidualTwins,
  mergeAnalyticsIdentities,
} from "./lib/analytics-identity.js";
export { AnalyticsProviderRegistry } from "./lib/analytics-provider-registry.js";
export { analyticsProvidersFromEnv } from "./lib/analytics-providers-from-env.js";
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
// --- On-site banners (thin over sendFeedItem, category `banner:<slot>`) ---
export {
  type SendBannerOptions,
  type SendBannerResult,
  sendBanner,
} from "./lib/banner.js";
// --- Boot output (engine-owned startup banner / structured ready log) ---
export {
  type ApiReadyInfo,
  getEngineVersion,
  reportApiReady,
  reportWorkerReady,
  type WorkerReadyInfo,
} from "./lib/boot.js";
// --- First-boot data-plane key bootstrap (API process only, mirrors admin) ---
export { bootstrapApiKeyFromEnv } from "./lib/boot-api-key.js";
// --- First-admin creation (CLI + boot bootstrap share this scrypt-correct path)
export { bootstrapAdminFromEnv } from "./lib/bootstrap-admin.js";
// --- Bucket transition emission (shared by real-time / cron / fast-expiry) ---
export {
  type BucketTransitionSource,
  emitBucketTransition,
} from "./lib/bucket-emit.js";
// --- Connector outbound actions (journey-callable, socket-free) ---
export {
  type SendConnectorActionArgs,
  sendConnectorAction,
} from "./lib/connector-actions.js";
// --- Connector-runtime liveness heartbeat (connector-neutral) ---
export {
  type ConnectorHeartbeat,
  type ConnectorHeartbeatHandle,
  getConnectorHeartbeat,
  startConnectorHeartbeat,
} from "./lib/connector-heartbeat.js";
// --- Single-use link codes (native connector /link → /verify identify loop) ---
export {
  type CreateLinkCodeResult,
  createLinkCode,
  generateLinkCode,
  hashLinkCode,
  LINK_CODE_MAX_PER_EMAIL,
  LINK_CODE_MAX_PER_USER,
  LINK_CODE_THROTTLE_WINDOW_SECONDS,
  LINK_CODE_TTL_SECONDS,
  type LinkCodeThrottleScope,
  type RedeemLinkCodeResult,
  redeemLinkCode,
} from "./lib/connector-link-codes.js";
// --- Generic signed connector state (CSRF + member-link binding) ---
export {
  type ConnectorStateIntent,
  signConnectorState,
  verifyConnectorState,
} from "./lib/connector-state.js";
// --- Contacts identity (resolve/create — used by connector member-link) ---
export { resolveOrCreateContact } from "./lib/contacts.js";
export {
  AdminAlreadyExistsError,
  type CreatedAdmin,
  createAdminUser,
} from "./lib/create-admin.js";
// --- Infrastructure singletons ---
export { getDb } from "./lib/db.js";
// --- Discord gateway-worker liveness heartbeat (Studio status) ---
export {
  type DiscordGatewayHeartbeat,
  getDiscordGatewayHeartbeat,
  startDiscordGatewayHeartbeat,
} from "./lib/discord-gateway-heartbeat.js";
// --- Sending-domain status service (cached; container-held) ---
export {
  createDomainStatusService,
  type DomainStatusService,
  type EngineDomainStatus,
  type TestModeState,
} from "./lib/domain-status.js";
// --- Email ---
export {
  getEmailService,
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
// --- In-app feed (sendFeedItem — sibling of sendEmail/sendConnectorAction) ---
export {
  IN_APP_LIST_ID,
  type SendFeedItemOptions,
  type SendFeedItemResult,
  sendFeedItem,
} from "./lib/feed.js";
export { isFrequencyCapped } from "./lib/frequency-cap.js";
export { addrSpecOf, hostOfFromAddress } from "./lib/from-address.js";
export { hatchet } from "./lib/hatchet.js";
// --- Identity service (resolve/merge + analytics merge propagation, §7) ---
export {
  createIdentityService,
  type IdentityService,
  type LinkContactArgs,
} from "./lib/identity-service.js";
export {
  generateIdentityToken,
  type IdentityTokenPayload,
  type IdentityTokenScope,
  InvalidIdentityTokenError,
  validateIdentityToken,
} from "./lib/identity-token.js";
// --- Ingestion pipeline ---
export {
  type IngestEvent,
  type IngestResult,
  ingestEvent,
} from "./lib/ingestion.js";
// --- Leader lease (connector-runtime singleton election) ---
export {
  acquireLeaderLease,
  newLeaseToken,
  releaseLeaderLease,
  renewLeaderLease,
} from "./lib/leader-lease.js";
// --- Managed tracked links (channel-agnostic mint — Studio/Discord/share) ---
export {
  type LinkType,
  type MintedLink,
  type MintLinkOptions,
  mintLink,
} from "./lib/links.js";
// --- Logging ---
export { createLogger, type Logger } from "./lib/logger.js";
export { createTrackedMailer } from "./lib/mailer.js";
// --- OAuth token manager (provider access-token cache + refresh) ---
export {
  ABSENT_RECHECK_MS,
  type CredentialState,
  type CredentialStore,
  createTokenManager,
  EXPIRY_SKEW_MS,
  FAILURE_BACKOFF_MS,
  HOGSEND_POSTHOG_CLIENT_ID,
  oauthCredentialPayloadSchema,
  type TokenManager,
} from "./lib/oauth-token-manager.js";
// --- Outbound webhooks: emit spine (Section 1.4) ---
export {
  emitOutbound,
  OUTBOUND_EVENTS,
  type OutboundEventName,
  type OutboundPayloads,
} from "./lib/outbound.js";
export { getPostHog } from "./lib/posthog.js";
// --- PostHog OAuth scopes (front-loaded set; gap-detector source of truth) ---
export { EXPECTED_POSTHOG_SCOPES } from "./lib/posthog-scopes.js";
// --- Provider credentials (encrypted-at-rest OAuth token store) ---
export {
  type CredentialKind,
  type DecryptedProviderCredential,
  type DerivedCredentialPayload,
  deleteAllProviderCredentials,
  deleteProviderCredential,
  getDerivedCredential,
  getProviderCredential,
  type OAuthCredentialPayload,
  ProviderCredentialDecryptError,
  type ProviderCredentialMeta,
  saveDerivedCredential,
  saveProviderCredential,
  toCredentialMeta,
} from "./lib/provider-credentials.js";
export {
  type AuthSecondaryStorage,
  createRedisSecondaryStorage,
  getRedis,
  getRedisIfConnected,
} from "./lib/redis.js";
// --- Self-service password reset (engine-owned, self-contained email) ---
export { sendResetPasswordEmail } from "./lib/reset-email.js";
// --- PostHog destination seed (idempotent; ENABLE_POSTHOG_DESTINATION) ---
export { seedPostHogDestination } from "./lib/seed-posthog-destination.js";
export {
  type ConfirmSemanticClickInput,
  type ConfirmSemanticClickResult,
  confirmSemanticClick,
  SEMANTIC_BURST_DISTINCT_LINKS,
  SEMANTIC_BURST_WINDOW_MS,
} from "./lib/semantic-click.js";
export { type MountStudioResult, mountStudio } from "./lib/studio.js";
// --- In-app survey/rating (sendSurvey — producer sugar over sendFeedItem) ---
export { type SendSurveyOptions, sendSurvey } from "./lib/survey.js";
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
  createTrackedLink,
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
/**
 * Publishable-key `userToken` mint/verify helpers.
 *
 * `generateUserToken` is the official SERVER-SIDE mint helper. It signs a
 * short-lived HMAC over a `userId` with `BETTER_AUTH_SECRET`. A publishable
 * (`pk_`) key is anon-only by default; to let an identified browser act on a
 * concrete `userId`, the HOST BACKEND calls this AFTER its own login and hands
 * the result to the browser:
 *
 * ```ts
 * // host server route, AFTER authenticating the user — NEVER expose the secret:
 * import { generateUserToken } from "@hogsend/engine";
 * const userToken = generateUserToken({
 *   secret: process.env.BETTER_AUTH_SECRET!,
 *   userId: session.user.id,
 *   expiresInSeconds: 3600,
 * });
 * // return { userToken } to the browser; the SDK threads it into every
 * // identity-asserting data-plane call (createHogsend({ userToken }) /
 * // <HogsendProvider userToken={...}>). On expiry the SDK calls
 * // config.onUserTokenExpiring() — point that at re-hitting this route.
 * ```
 *
 * SERVER-SIDE ONLY: it uses `node:crypto` and needs `BETTER_AUTH_SECRET`. Do
 * NOT mount it as a route and do NOT call it from a browser (it would leak the
 * signing secret). `verifyUserToken` is the symmetric half the engine wires
 * into every publishable-reachable handler.
 */
export {
  generateUserToken,
  InvalidUserTokenError,
  type UserTokenPayload,
  verifyUserToken,
} from "./lib/user-token.js";
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
  webhookSourceToConnector,
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
export {
  importSuppressionsTask,
  type MappedSuppressionRow,
  mapSuppressionRow,
  SUPPRESSION_REASONS,
  type SuppressionImportRow,
  type SuppressionReason,
} from "./workflows/import-suppressions.js";
export {
  reapStuckCampaignsTask,
  sendCampaignTask,
} from "./workflows/send-campaign.js";
// --- Built-in Hatchet workflow tasks ---
export { sendEmailTask } from "./workflows/send-email.js";
export { sendFeedTask } from "./workflows/send-feed.js";
