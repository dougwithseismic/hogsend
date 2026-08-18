// Install the production Hatchet binding. The `./journeys` authoring subpath
// intentionally omits this side effect so journey modules stay test-importable
// without database or Hatchet credentials.
import "./journeys/journey-task-runtime.js";

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
  ReturnPathState,
  SendResult,
  SetReturnPathInput,
  /** @deprecated Use {@link EmailEvent}. Kept for one minor. */
  WebhookEvent,
  WebhookHandlerMap,
} from "@hogsend/core";
// Core helpers used by content journeys (days/hours/minutes, condition + journey
// types) so content can import everything from `@hogsend/engine`.
export * from "@hogsend/core";
// --- Capability-provider contracts (canonical origin: @hogsend/core) ---
// Email provider contract + analytics contract, plus `bySubject` (the
// either/or history scope every engine-side history read is expected to move
// onto), re-exported so consumers can import them from `@hogsend/engine`.
// (`SendEmailOptions` is intentionally omitted here: the engine's public
// `SendEmailOptions` is the high-level journey-facing send options from
// `./lib/email.js`; the provider-contract `SendEmailOptions` remains available
// via `@hogsend/core`.)
// --- Account links: provider contract (canonical origin: @hogsend/core) ---
// Already covered by the `export * from "@hogsend/core"` above — re-named here
// for discoverability, mirroring the email/analytics contract re-exports.
export {
  ACCOUNT_LINK_HOOK_TIMEOUT_MS,
  ACCOUNT_LINK_ID_RE,
  AccountLinkCallbackError,
  type AccountLinkCapabilities,
  type AccountLinkHooks,
  type AccountLinkMeta,
  type AccountLinkProvider,
  bySubject,
  defineAccountLink,
  defineAnalyticsProvider,
  defineEmailProvider,
  type LinkedIdentity,
  type LinkTokens,
  RESERVED_ACCOUNT_LINK_IDS,
  type Subject,
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
// The two built-in account-link providers — config over the @hogsend/core
// presets (DECISIONS §3.1), exported so a consumer can construct one directly
// with code-supplied config and pass it via `accountLinks.providers`.
export {
  type SteamAccountLinkConfig,
  steamAccountLink,
  type TwitchAccountLinkConfig,
  twitchAccountLink,
} from "./account-links/index.js";
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
export { step } from "./campaigns/steps.js";
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
  type ConnectorActionSkipped,
  type DefinedConnectorAction,
  defineConnectorAction,
  isConnectorActionSkipped,
  type MemberAudience,
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
// --- Native feature flags (DB-backed, sticky evaluation) ---
export {
  type FlagReconcileResult,
  reconcileDefinedFlags,
} from "./flags/reconcile.js";
// --- Journeys ---
export { BLUEPRINT_RUN_EVENT } from "./journeys/constants.js";
export {
  type DefinedJourney,
  defineJourney,
} from "./journeys/define-journey.js";
export { JourneyExitedError } from "./journeys/errors.js";
export {
  type EventPayloadInput,
  type ExecuteJourneyRunOptions,
  type ExecuteJourneyRunResult,
  executeJourneyRun,
  insertEnrollment,
  type JourneyDurableCtx,
  type JourneyStateRow,
} from "./journeys/execute-journey-run.js";
// --- Journey graph extractor (Studio visual workflow) ---
export {
  buildJourneyGraph,
  degradedGraphFromMeta,
} from "./journeys/graph/build-graph.js";
export {
  type GroupScopeOption,
  GroupScopeUnresolvableError,
  resolveGroupScope,
} from "./journeys/group-scope.js";
export {
  createMemoize,
  deriveJourneyKey,
  getJourneyBoundary,
  type JourneyBoundary,
  type JourneyConnectorEffect,
  type JourneyEmailEffect,
  type JourneyFeedEffect,
  type JourneyServiceOverrides,
  type JourneySmsEffect,
  parseJourneySendSite,
  registerKey,
  registerRecordLabel,
  runWithJourneyBoundary,
} from "./journeys/journey-boundary.js";
export {
  buildGroupEventFilter,
  createJourneyContext,
} from "./journeys/journey-context.js";
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
  computeJourneyVersionHash,
  normalizeRunSource,
} from "./journeys/journey-version.js";
export {
  type RecordNamespace,
  recordOnce,
  stripRecordNamespaces,
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
// The one origin allowlist parser (PRD 07 `returnTo`, PRD 10 `postMessage`) —
// fail-loud at boot; the container calls it, exported for consumers/tests.
export {
  isAllowedReturnTo,
  parseAllowedOrigins,
} from "./lib/account-link-origins.js";
// The container-held provider registry (`client.accountLinkProviders`).
export { AccountLinkProviderRegistry } from "./lib/account-link-provider-registry.js";
// The server-side WARM minter. Returns an ENGINE-origin `/start` URL — never a
// provider authorize URL (DECISIONS §15.2). PRD 09's `POST
// /v1/accounts/link-url` returns exactly this value and PRD 13's embed derives
// its `postMessage` expectedOrigin from it.
export {
  AccountLinkReturnToError,
  type MintAccountLinkUrlArgs,
  mintAccountLinkUrl,
} from "./lib/account-link-url.js";
// --- Account links (the link store — the ONE writer of `linked_accounts`) ---
//
// Deliberately NARROW. This barrel is the committed semver boundary for
// `@hogsend/engine`, so anything exported here is a promise we keep or
// major-bump. `lockPairs`, `pairLockKey`, `MAX_VERSION_RACE_RETRIES` and
// `AccountLinkLockSetChangedError` are the store's internal mechanics — how we
// happen to take advisory locks and signal a stale pre-read today — and the PRD
// documents the last of those as an INTERNAL retry signal. They stay module-
// private (still importable within the engine, and the tests import the module
// directly) so a change to the locking strategy is not a breaking change.
export {
  AccountLinkVersionRaceError,
  type ContactUnlinkFact,
  type DisplacedLink,
  getLiveLink,
  type LinkAccountInput,
  type LinkAccountResult,
  type LinkedAccountRecord,
  type LinkMutationStatus,
  type LinkOwner,
  linkAccount,
  listLinkHistory,
  listLiveLinksForContact,
  type UnlinkAccountInput,
  type UnlinkAccountInTxResult,
  type UnlinkAccountResult,
  unlinkAccount,
  unlinkAccountInTx,
  unlinkAccountsForContactInTx,
} from "./lib/account-links.js";
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
// --- Attachments (engine-side gate + email_sends metadata shape, PRD 17) ---
export {
  type AttachmentSendMetadata,
  AttachmentsUnsupportedError,
  assertAttachmentsSendable,
  attachmentSendMetadata,
} from "./lib/attachments.js";
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
// --- Journey blueprints: service layer shared by admin routes + tools (§9) ---
export {
  type BlueprintRegistryContainer,
  type BlueprintRow,
  type BlueprintServiceContainer,
  blueprintCreateBaseSchema,
  blueprintPatchFieldsSchema,
  type CreateBlueprintInput,
  type CreateBlueprintResult,
  createBlueprint,
  type DisableBlueprintResult,
  disableBlueprint,
  type EnableBlueprintResult,
  enableBlueprint,
  findBlueprintRow,
  type PromoteBlueprintResult,
  promoteBlueprint,
  type SerializedBlueprint,
  serializeBlueprint,
  type UpdateBlueprintPatch,
  type UpdateBlueprintResult,
  updateBlueprint,
  validateBlueprintGraphForSave,
} from "./lib/blueprints.js";
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
// `resolveContactNoCreate` is the refuse-on-miss sibling (D1): same resolution,
// but pure observation never mints a `contacts` row.
// `identifiedContactFilter` is the read-side counterpart (PRD 01): the single
// "has this person ever identified?" predicate behind `?identity=`.
// `deleteIdentityAliasesForContact` is the erasure hook (PRD 02 T1): a
// consumer-built deletion flow that soft-deletes `contacts` rows directly must
// call it too, or the erased person's identity keys survive in
// `contact_aliases`.
// `ResolvePolicy`/`IdentityKind` (PRD 06): the explicit caller-declared trust
// shape both resolver entry points accept via `policy` — the additive
// replacement for the deprecated `restrictToAnonymous`/`allowCreate` booleans.
// `MergedLinkUnlink` (PRD 04): the link soft-unlink facts a collide-MERGE
// reports on the resolve result (`linkUnlinks`), for post-commit emission.
export {
  deleteIdentityAliasesForContact,
  type IdentityKind,
  identifiedContactFilter,
  type MergedLinkUnlink,
  type ResolvePolicy,
  resolveContactNoCreate,
  resolveOrCreateContact,
} from "./lib/contacts.js";
// --- Conversion dispatch (plan §5.2): destinations registry + delivery ---
export {
  ConversionDestinationRegistry,
  conversionEventId,
  createConversionDispatches,
  deliverConversionDispatch,
  enqueueConversionDispatches,
  getConversionDestinations,
  recoverClickContext,
  resetConversionDestinations,
  setConversionDestinations,
} from "./lib/conversion-dispatch.js";
// --- Conversion points (plan §5.1): registry + ingest-time evaluation ---
export {
  ConversionRegistry,
  evaluateConversionsAtIngest,
  type FiredConversion,
  getConversionRegistry,
  resetConversionRegistry,
  setConversionRegistry,
} from "./lib/conversions.js";
export {
  AdminAlreadyExistsError,
  type CreatedAdmin,
  createAdminUser,
} from "./lib/create-admin.js";
// --- CRM sync (provider registry + the stage-event spine sink) ---
export {
  type AppliedStageChange,
  applyCrmStageEvent,
  ensureCrmLinks,
  resolveCrmLinkedContact,
} from "./lib/crm-deals.js";
export {
  DEAL_QUOTED,
  DEAL_SOLD,
  FUNNEL_STAGE_CHANGED,
  ingestCrmStageEvents,
} from "./lib/crm-ingest.js";
export { CrmProviderRegistry } from "./lib/crm-provider-registry.js";
export {
  getCrmSyncConfig,
  resetCrmSyncConfig,
  setCrmSyncConfig,
} from "./lib/crm-registry-singleton.js";
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
// --- Enrichment provider registry (Refinement; container-held, keyed by meta.id) ---
// The contract itself (EnrichmentProvider, defineEnrichmentProvider, …) is
// re-exported via `export * from "@hogsend/core"` above.
export { EnrichmentProviderRegistry } from "./lib/enrichment-provider-registry.js";
export { enrichmentProvidersFromEnv } from "./lib/enrichment-providers-from-env.js";
export {
  getEnrichmentProvider,
  getEnrichmentProviderRegistry,
  resetEnrichmentProviders,
  setEnrichmentProviders,
} from "./lib/enrichment-registry-singleton.js";
// --- Enrollment guards ---
export { checkEmailPreferences } from "./lib/enrollment-guards.js";
export {
  type EnrollmentPolicyFacts,
  type EnrollmentPolicyResult,
  evaluateEnrollmentPolicy,
} from "./lib/enrollment-policy.js";
// --- In-app feed (sendFeedItem — sibling of sendEmail/sendConnectorAction) ---
export {
  IN_APP_LIST_ID,
  type SendFeedItemOptions,
  type SendFeedItemResult,
  sendFeedItem,
} from "./lib/feed.js";
export {
  type EvaluableFlag,
  emptySnapshot,
  evaluateFlag,
  evaluateFlagsForContact,
  evaluateTargeting,
  flagBucket,
  flagUnit,
  loadTargetingSnapshot,
  type TargetingEvalContext,
  type TargetingSnapshot,
} from "./lib/flags.js";
export {
  FlagRegistry,
  getFlagRegistry,
  resetFlagRegistry,
  setFlagRegistry,
} from "./lib/flags-registry.js";
export { countRecentSends, isFrequencyCapped } from "./lib/frequency-cap.js";
export { addrSpecOf, hostOfFromAddress } from "./lib/from-address.js";
export { FunnelRegistry } from "./lib/funnel-registry.js";
// --- Base-currency FX lens (optional; docs/groups.md §Base-currency lens) ---
export {
  createFrankfurterFxProvider,
  createFxLens,
  createStaticFxProvider,
  type FxLens,
  type FxRatesToBase,
  fxProviderFromEnv,
  parseFxRatesEnv,
} from "./lib/fx.js";
export {
  computeGlobalControlReadout,
  GLOBAL_CONTROL_SCAN_CEILING,
  type GlobalControlReadout,
} from "./lib/global-control-readout.js";
export { hatchet } from "./lib/hatchet.js";
export {
  globalControlPercent,
  holdoutBucket,
  isGlobalControl,
  isHeldOut,
} from "./lib/holdout.js";
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
  checkBlueprintTriggers,
  type IngestEvent,
  type IngestResult,
  ingestEvent,
  ingestTransformResult,
} from "./lib/ingestion.js";
// --- Reconciled journey-lift helper (impact experiments D4.1) — the ONE
// implementation of the causal cohort math, shared by /lift (2a), /impact
// (2b), and the impact digest (3b) ---
export {
  computeJourneyLift,
  computeLiftValues,
  type JourneyLiftResult,
  type LiftCohort,
} from "./lib/journey-lift.js";
// --- Leader lease (connector-runtime singleton election) ---
export {
  acquireLeaderLease,
  newLeaseToken,
  releaseLeaderLease,
  renewLeaderLease,
} from "./lib/leader-lease.js";
// --- Holdout lift statistics (impact plan §4.2) ---
export {
  betaWinProbability,
  computeLift,
  type LiftVerdict,
  MIN_COMBINED_CONVERSIONS,
  SMALL_SAMPLE_FLOOR,
} from "./lib/lift-stats.js";
// --- Managed tracked links (channel-agnostic mint — Studio/Discord/share) ---
// NOTE: the QR scan-row plumbing (ensureQrTrackedLink, the canonical-row
// filter, the 'qr' source marker) is deliberately NOT exported — it is
// internal mechanics behind the /qr endpoint, not semver surface.
export {
  IdempotencyConflictError,
  LinkOwnershipError,
  type LinkType,
  type MintedLink,
  type MintLinkOptions,
  mintLink,
  normalizeSlug,
  SlugTakenError,
  vanityUrlFor,
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
  type ImpactDigestEntry,
  type ImpactDigestLiftEntry,
  type ImpactDigestShippedEntry,
  type ImpactVersionCohort,
  OUTBOUND_EVENTS,
  type OutboundEventName,
  type OutboundPayloads,
} from "./lib/outbound.js";
export { isE164, normalizePhone } from "./lib/phone.js";
export { getPostHog } from "./lib/posthog.js";
// --- PostHog OAuth scopes (front-loaded set; gap-detector source of truth) ---
export { EXPECTED_POSTHOG_SCOPES } from "./lib/posthog-scopes.js";
// --- Recipient preferences (shared aggregated read across email/feed/connectors) ---
export {
  type RecipientPreferences,
  readRecipientPreferences,
} from "./lib/preferences.js";
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
// --- Referral store (the ONE writer of referral_touches; NEVER emits) ---
// The store returns mutation FACTS; the intent layer emits `referral.*`
// outbound and re-ingests for journeys, side by side (PRD 05 §6). Pinned by
// `lib/referrals-no-emit.test.ts`.
export {
  type BindTouchesInput,
  type BindTouchesResult,
  bindTouches,
  type ListTouchesInput,
  listTouchesForReferee,
  listTouchesForReferrer,
  type QualifyTouchInput,
  type QualifyTouchResult,
  qualifyTouch,
  REFERRAL_IDEMPOTENCY_PROPERTY,
  REFERRAL_VETO_REASON_PROPERTY,
  type RecordTouchInput,
  type RecordTouchResult,
  type ReferralRejectReason,
  type ReferralTouchRecord,
  type ReferralTouchSource,
  type ReferralTouchStatus,
  type RejectTouchInput,
  type RejectTouchResult,
  recordTouch,
  rejectTouch,
} from "./lib/referrals.js";
// --- Refinement (`refineContact` — a STANDALONE import, never on `ctx`) ---
export {
  REFINE_EVENT,
  type RefineContactOptions,
  type RefineContactResult,
  refineContact,
} from "./lib/refine.js";
export { flattenTraits } from "./lib/refine-traits.js";
// --- Self-service password reset (engine-owned, self-contained email) ---
export { sendResetPasswordEmail } from "./lib/reset-email.js";
// --- Revenue rollups (the event spine's value/currency columns) ---
export {
  type ContactRevenue,
  type ContactRevenueTotal,
  getContactRevenue,
} from "./lib/revenue.js";
// --- PostHog destination seed (idempotent; ENABLE_POSTHOG_DESTINATION) ---
export { seedPostHogDestination } from "./lib/seed-posthog-destination.js";
export {
  type ConfirmSemanticClickInput,
  type ConfirmSemanticClickResult,
  confirmSemanticClick,
  SEMANTIC_BURST_DISTINCT_LINKS,
  SEMANTIC_BURST_WINDOW_MS,
} from "./lib/semantic-click.js";
// --- Sending-subdomain setup guidance (static; one source for all surfaces) ---
export {
  exampleSendingSubdomain,
  looksLikeRootDomain,
  SENDING_DOMAIN_GUIDANCE,
  type SendingDomainGuidance,
} from "./lib/sending-domain-guidance.js";
// --- SMS ---
export {
  getSmsService,
  type SendSmsOptions as SendSmsJourneyOptions,
  type SendSmsResult,
  sendSms,
  setSmsService,
} from "./lib/sms.js";
// --- SMS inbound consent helpers (phone-track grant/opt-out) ---
export {
  grantPhoneConsent,
  recordPhoneOptOut,
} from "./lib/sms-inbound.js";
// --- SMS link shortening (pure rewriter; the insert rides the send txn) ---
export {
  generateShortCode,
  isShortCodeCollision,
  type PendingSmsLink,
  planSmsLinkRewrite,
  SHORT_CODE_ALPHABET,
  SHORT_CODE_LENGTH,
  type SmsLinkRewritePlan,
} from "./lib/sms-link-tracking.js";
// --- SMS mailer factory (the engine-owned tracked sender; mirrors createTrackedMailer) ---
export { createTrackedSmsSender } from "./lib/sms-mailer.js";
// --- SMS provider registry (container-held, keyed by meta.id) ---
export { SmsProviderRegistry } from "./lib/sms-provider-registry.js";
// --- SMS service (engine-owned tracked SMS sender) ---
export type {
  SmsService,
  SmsServiceConfig,
  SmsServiceSendOptions,
  SmsServiceWebhookResult,
  SmsTrackedSendResult,
} from "./lib/sms-service-types.js";
export { SMS_CHANNEL_ID } from "./lib/sms-tracked.js";
export {
  type LoadedSnippet,
  loadSnippet,
  resolveSnippetPath,
} from "./lib/snippet.js";
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
// --- First-party tracking event names (touchpoint-classed in @hogsend/core) ---
export {
  EMAIL_LINK_CLICKED,
  EMAIL_OPENED,
  EMAIL_REPLIED,
  LINK_ARRIVED,
  LINK_CLICKED,
  SMS_LINK_CLICKED,
} from "./lib/tracking-event-names.js";
export {
  pushSmsTrackingEvent,
  pushTrackingEvent,
  resolveEmailSendContext,
  resolveEmailSendContextByMessageId,
  /**
   * @deprecated Kept for one minor; use
   * {@link resolveEmailSendContextByMessageId}.
   */
  resolveEmailSendContextByResendId,
  resolveSmsSendContext,
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
// NOTE: `IN_APP_LIST_ID` is canonically defined in `./lists/channels.js` but
// exported here via `./lib/feed.js` (which re-exports it) to keep its
// pre-existing import path stable — do NOT also export it from channels.js
// (a duplicate named export).
export { synthesizeChannelLists } from "./lists/channels.js";
export {
  type DefinedList,
  defineList,
  type ListKind,
  type ListMeta,
} from "./lists/define-list.js";
export { buildListRegistry, ListRegistry } from "./lists/registry.js";
export {
  getListRegistry,
  resetListRegistry,
  setListRegistry,
} from "./lists/registry-singleton.js";
// --- Journey blueprints: shared authoring-guide text (tools + @hogsend/mcp) ---
export {
  BLUEPRINT_AUTHORING_GUIDE,
  GRAPH_FORMAT,
  ISSUE_LOOP_HINT,
} from "./mcp/authoring-guide.js";
// --- Journey blueprints: agent-facing authoring tools (spec §9, phase 4) ---
export {
  type BlueprintToolDefinition,
  type BlueprintToolInvalidInput,
  type BlueprintToolIssue,
  createJourneyBlueprintTools,
  type JourneyBlueprintTools,
  type JourneyBlueprintToolsOptions,
} from "./mcp/blueprint-tools.js";
export {
  createRateLimit,
  type RateLimitOptions,
} from "./middleware/rate-limit.js";
// --- Middleware (consumer-mounted routes, e.g. the @hogsend/mcp hosted route) ---
export { requireAdmin } from "./middleware/require-admin.js";
// The `/v1/accounts/*` serialization boundary — TWO SHAPES, ONE ROW (PRD 09
// T2). `serializePublicLinkedAccount` is the ONLY shape `GET /v1/accounts/me`
// may return: four display keys, no id, no version. Exported so PRD 12's
// server SDK and PRD 13's embed type against the same declarations the routes
// answer with, rather than re-declaring them and drifting.
export {
  linkedAccountSchema,
  publicLinkedAccountSchema,
  type SerializedLinkedAccount,
  type SerializedPublicLinkedAccount,
  serializeLinkedAccount,
  serializePublicLinkedAccount,
} from "./routes/accounts/serialize.js";
export { createSnippetRouter } from "./routes/snippet.js";
// --- Contact sources (Clay/Attio/generic-webhook → cold prospects) ---
export {
  type ColdChannelPosture,
  type ColdPosture,
  type ContactSourceMeta,
  type ContactWriteBack,
  contactSourceToWebhookSource,
  type DefinedContactSource,
  defaultColdPosture,
  defineContactSource,
  isColdChannelAllowed,
  resolveColdPosture,
} from "./sources/define-contact-source.js";
export {
  buildContactSourceRegistry,
  ContactSourceRegistry,
  getContactSourceRegistry,
  setContactSourceRegistry,
} from "./sources/registry.js";
export {
  normalizeWebhookContactEvent,
  type WebhookContactPayload,
  type WebhookContactSourceOptions,
  webhookContactPayloadSchema,
  webhookContactSource,
} from "./sources/webhook-source.js";
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
  intercomSource,
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
// --- History contact_id backfill (PRD 04): periodic reconcile sweep + enqueue,
// --- plus T6's invariant probe (`flipReady` = the read-flip entry gate) ---
export {
  CONTACT_ID_BACKFILL_FORMAT,
  type ContactIdBackfillCounts,
  type ContactIdBackfillInput,
  type ContactIdBackfillResult,
  type ContactIdBackfillTable,
  type ContactIdVerifyCounts,
  type ContactIdVerifyResult,
  contactIdBackfillTask,
  contactIdResweepIntervalMs,
  enqueueContactIdBackfill,
  runContactIdBackfill,
  verifyContactIdBackfill,
} from "./workflows/backfill-contact-id.js";
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
export {
  checkAlertsTask,
  surfaceStrandedWaiting,
} from "./workflows/check-alerts.js";
export {
  crmReconcileTask,
  runCrmReconcile,
} from "./workflows/crm-reconcile.js";
// --- Outbound webhooks: durable delivery task + reaper (Section 1.5) ---
export {
  deliverWebhookTask,
  reapDueWebhookDeliveriesTask,
} from "./workflows/deliver-webhook.js";
// --- Identity alias backfill (PRD 02): task + boot enqueue + parity probe ---
export {
  type AliasParityRow,
  enqueueIdentityAliasBackfill,
  IDENTITY_ALIAS_BACKFILL_FORMAT,
  type IdentityAliasBackfillInput,
  type IdentityAliasBackfillResult,
  identityAliasBackfillTask,
  identityAliasParity,
  runIdentityAliasBackfill,
} from "./workflows/identity-alias-backfill.js";
export {
  buildImpactDigest,
  detectLiftCrossings,
  detectShippedVersions,
  type ImpactDigestInput,
  impactDigestTask,
} from "./workflows/impact-digest.js";
export { importContactsTask } from "./workflows/import-contacts.js";
export {
  importSuppressionsTask,
  type MappedSuppressionRow,
  mapSuppressionRow,
  SUPPRESSION_REASONS,
  type SuppressionImportRow,
  type SuppressionReason,
} from "./workflows/import-suppressions.js";
// --- Journey blueprints: the generic interpreter task (spec §5/§6) ---
export {
  type BlueprintRunPayload,
  blueprintMetaFromRow,
  type JourneyBlueprintRow,
  journeyBlueprintInterpreter,
  type WalkBlueprintGraphOptions,
  walkBlueprintGraph,
} from "./workflows/journey-blueprint-interpreter.js";
export {
  reapStuckCampaignsTask,
  sendCampaignTask,
} from "./workflows/send-campaign.js";
// --- Built-in Hatchet workflow tasks ---
export { sendEmailTask } from "./workflows/send-email.js";
export { sendFeedTask } from "./workflows/send-feed.js";
