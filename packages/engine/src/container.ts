import type { HatchetClient } from "@hatchet-dev/typescript-sdk/v1/index.js";
import type {
  AnalyticsEventMirrorConfig,
  AnalyticsProvider,
  ConversionDestination,
  CrmProvider,
  CrmStageMap,
  DefinedConversion,
  DefinedFunnel,
  EmailProvider,
  FunnelStageEntry,
  JourneySourceLocation,
  PostHogService,
  SmsProvider,
  TimeZone,
} from "@hogsend/core";
import {
  crmPipeline,
  DEFAULT_FUNNEL_ID,
  DEFAULT_PIPELINE_LADDER,
  defineFunnel,
} from "@hogsend/core";
import type { BucketRegistry, JourneyRegistry } from "@hogsend/core/registry";
import type { SendWindow } from "@hogsend/core/schedule";
import {
  createDatabase,
  type Database,
  type DatabaseClient,
  type JournalShape,
} from "@hogsend/db";
import type { TemplateDefinition, TemplateRegistry } from "@hogsend/email";
import type { SmsTemplateDefinition, SmsTemplateRegistry } from "@hogsend/sms";
import { createBucketAccessor } from "./buckets/bucket-access.js";
import type { DefinedBucket } from "./buckets/define-bucket.js";
import {
  buildBucketRegistry,
  collectBucketReactionJourneys,
} from "./buckets/registry.js";
import type { DefinedCampaign } from "./campaigns/define-campaign.js";
import {
  ConnectorActionRegistry,
  setConnectorActionRegistry,
} from "./connectors/action-registry-singleton.js";
import type { DefinedConnectorAction } from "./connectors/define-action.js";
import type { DefinedConnector } from "./connectors/define-connector.js";
import { connectorsFromEnv } from "./connectors/presets/index.js";
import {
  ConnectorRegistry,
  setConnectorRegistry,
} from "./connectors/registry-singleton.js";
import type { DefinedDestination } from "./destinations/define-destination.js";
import { destinationsFromEnv } from "./destinations/presets/index.js";
import {
  DestinationRegistry,
  setDestinationRegistry,
} from "./destinations/registry-singleton.js";
import { env } from "./env.js";
import { setClientScheduleDefaults } from "./journeys/client-defaults-singleton.js";
import type { DefinedJourney } from "./journeys/define-journey.js";
import { getJourneySourceLocations } from "./journeys/journey-source-locations-singleton.js";
import { getJourneySources } from "./journeys/journey-sources-singleton.js";
import { buildJourneyRegistry } from "./journeys/registry.js";
import {
  isAnalyticsProvider,
  wrapLegacyAnalyticsService,
} from "./lib/analytics-adapter.js";
import { AnalyticsProviderRegistry } from "./lib/analytics-provider-registry.js";
import {
  analyticsProvidersFromEnv,
  buildStoredPosthogProvider,
} from "./lib/analytics-providers-from-env.js";
import {
  setAnalytics,
  setAnalyticsEventMirror,
} from "./lib/analytics-singleton.js";
import { type Auth, createAuth } from "./lib/auth.js";
import {
  ConversionDestinationRegistry,
  setConversionDestinations,
  setConversionDispatchTask,
} from "./lib/conversion-dispatch.js";
import {
  ConversionRegistry,
  defaultRevenueConversion,
  setConversionRegistry,
} from "./lib/conversions.js";
import { CrmProviderRegistry } from "./lib/crm-provider-registry.js";
import { setCrmSyncConfig } from "./lib/crm-registry-singleton.js";
import {
  createDomainStatusService,
  type DomainStatusService,
} from "./lib/domain-status.js";
import { setEmailService } from "./lib/email.js";
import { EmailProviderRegistry } from "./lib/email-provider-registry.js";
import { emailProvidersFromEnv } from "./lib/email-providers-from-env.js";
import type {
  EmailService,
  FrequencyCapConfig,
} from "./lib/email-service-types.js";
import { FunnelRegistry } from "./lib/funnel-registry.js";
import { hatchet } from "./lib/hatchet.js";
import {
  createIdentityService,
  type IdentityService,
} from "./lib/identity-service.js";
import { createLogger, type Logger } from "./lib/logger.js";
import { createTrackedMailer } from "./lib/mailer.js";
import { createRedisSecondaryStorage, getRedis } from "./lib/redis.js";
import { sendResetPasswordEmail } from "./lib/reset-email.js";
import { seedPostHogDestination } from "./lib/seed-posthog-destination.js";
import { setSmsService } from "./lib/sms.js";
import { createTrackedSmsSender } from "./lib/sms-mailer.js";
import { SmsProviderRegistry } from "./lib/sms-provider-registry.js";
import { smsProvidersFromEnv } from "./lib/sms-providers-from-env.js";
import type { SmsService } from "./lib/sms-service-types.js";
import { prepareTrackedHtml } from "./lib/tracking.js";
import { createUnconfiguredEmailProvider } from "./lib/unconfigured-email-provider.js";
import { synthesizeChannelLists } from "./lists/channels.js";
import {
  type DefinedList,
  isReservedListId,
  RESERVED_LIST_IDS,
} from "./lists/define-list.js";
import { buildListRegistry, type ListRegistry } from "./lists/registry.js";
import {
  contactSourceToWebhookSource,
  type DefinedContactSource,
} from "./sources/define-contact-source.js";
import {
  buildContactSourceRegistry,
  type ContactSourceRegistry,
} from "./sources/registry.js";
import {
  type DefinedWebhookSource,
  webhookSourceToConnector,
} from "./webhook-sources/define-webhook-source.js";
import { dispatchConversionTask } from "./workflows/dispatch-conversion.js";

export interface HogsendDefaults {
  /** Global fallback IANA timezone for scheduling. Defaults to "UTC". */
  timezone: TimeZone;
  /** Default quiet-hours / send window auto-applied by `ctx.when`. */
  sendWindow?: SendWindow;
  /** Optional per-recipient frequency cap enforced in the mailer. */
  frequencyCap?: FrequencyCapConfig;
}

export interface HogsendClient {
  env: typeof env;
  logger: Logger;
  db: Database;
  dbClient: DatabaseClient;
  auth: Auth;
  emailService: EmailService;
  /**
   * The container-held registry of email providers, keyed by `meta.id`. The
   * `POST /v1/webhooks/email/:providerId` route resolves the verifying provider
   * out of this. Holds at least the resolved active provider.
   */
  emailProviders: EmailProviderRegistry;
  /**
   * The single resolved active email provider (the one the mailer sends
   * through). Resolved from `opts.email.defaultProvider` / `EMAIL_PROVIDER`,
   * defaulting to the env-built Resend provider for byte-for-byte parity.
   */
  emailProvider: EmailProvider;
  /**
   * Cached sending-domain status for the ACTIVE provider. Consumed by the
   * mailer's test-mode check (F3 — sync `testModeCached()` per send), the
   * `GET/POST /v1/admin/domain` routes, and (via HTTP) the CLI
   * (`hogsend domain`) + Studio Setup view. In-memory cache only; the per-send
   * path never awaits a provider call.
   */
  domainStatus: DomainStatusService;
  /**
   * The app's template registry (key → component + subject + category +
   * optional preview/examples). Same object threaded into the engine mailer;
   * exposed here so admin preview/catalog routes can enumerate keys and render
   * templates without going through a send. Empty when no templates are wired.
   */
  templates: TemplateRegistry;
  /**
   * The engine-owned tracked SMS sender (the SMS sibling of {@link emailService}).
   * When no SMS provider is configured this is an inert stub whose `send` throws
   * an actionable error — so an existing deploy without Twilio creds boots clean.
   */
  smsService: SmsService;
  /**
   * The container-held registry of SMS providers, keyed by `meta.id`. The
   * `POST /v1/webhooks/sms/:providerId` route resolves the verifying provider
   * out of this. Empty when no SMS provider is configured.
   */
  smsProviders: SmsProviderRegistry;
  /**
   * The single resolved active SMS provider the tracked sender delivers through.
   * Undefined when no SMS provider is configured.
   */
  smsProvider?: SmsProvider;
  /**
   * The container-held registry of CRM providers, keyed by `meta.id`. The
   * `POST /v1/webhooks/crm/:providerId` route resolves the verifying provider
   * out of this and the reconciliation poll walks it. Unlike email/SMS there
   * is no single "active" CRM — many sync concurrently; `pushLead` callers
   * name the provider. Empty when none configured.
   */
  crmProviders: CrmProviderRegistry;
  /**
   * The funnel registry (§5b.4): every `defineFunnel` plus the synthesized
   * `"default"` carrying the crm sugar. Routes stage events by
   * (provider, pipeline) claim; admin stats/Studio render per funnel.
   */
  funnels: FunnelRegistry;
  /**
   * The container-held registry of analytics providers, keyed by `meta.id` —
   * the analytics sibling of {@link emailProviders}. Built from env presets
   * (`analyticsProvidersFromEnv`) merged consumer-last.
   */
  analyticsProviders: AnalyticsProviderRegistry;
  /**
   * The single resolved ACTIVE analytics provider (identity PULL + person
   * writes + capture). Undefined when nothing is configured — every consumer
   * treats that as a silent no-op.
   */
  analytics?: AnalyticsProvider;
  /**
   * Identity-attach helper that resolves/merges a contact AND propagates the
   * analytics merge (§5.3) in one call, for identity-attach OUTSIDE the
   * `/v1/events` ingest path. Discord `/link` (§7) wires its `resolveContact`
   * callback to `client.identity.linkContact` so a successful contact-merge
   * folds the discord-keyed person into the canonical one through the SAME
   * engine emission ingest uses — never bespoke per-consumer plumbing.
   */
  identity: IdentityService;
  registry: JourneyRegistry;
  /**
   * Map of enabled journey id → its captured `run` source string. Populated by
   * `buildJourneyRegistry` (skips journeys whose source failed to serialize).
   * Consumed by the Studio journey-graph route, which parses the source lazily
   * with acorn to derive a visual workflow. Empty when no journeys are wired.
   */
  journeySources: Map<string, string>;
  /**
   * Map of enabled journey id → its `defineJourney` call-site `{ path, line }`.
   * Populated by `buildJourneyRegistry`. Consumed by the Studio journey-graph
   * route to build an "open in editor" deep link. Absent ids had no capturable
   * call-site (e.g. bucket-generated reaction journeys).
   */
  journeySourceLocations: Map<string, JourneySourceLocation>;
  /**
   * The bucket registry (id map + event/property inverted indexes for candidate
   * narrowing). Built and installed as the process singleton at client build;
   * the real-time ingest path reads it via `getBucketRegistrySingleton()`.
   * Empty when no buckets are wired.
   */
  bucketRegistry: BucketRegistry;
  /**
   * The email-list registry (D3): code-defined subscription categories layered
   * on `email_preferences.categories`, with the LOCKED polarity rule that is the
   * single source of truth for the mailer's suppression check AND the preference
   * center. Built and installed as the process singleton at client build (read
   * elsewhere via `getListRegistry()`). Empty when no lists are wired.
   */
  listRegistry: ListRegistry;
  /**
   * Code-defined one-shot campaigns (broadcasts), verbatim from
   * `opts.campaigns`. The worker's boot reconciler turns them into scheduled
   * `campaigns` rows; empty when none are wired.
   */
  campaigns: DefinedCampaign[];
  /**
   * The unified inbound CONNECTOR registry, keyed by `meta.id`. Holds every
   * transport: webhook (the `:sourceId` dispatch + legacy webhookSources),
   * gateway, and poll. Installed as the process singleton in BOTH the API and
   * worker. The webhook route reads `getByTransport("webhook")`; the generic
   * `/v1/connectors/:id/*` routes read `get(id).handlers`.
   */
  connectorRegistry: ConnectorRegistry;
  /**
   * The contact-source registry (Clay/Attio/generic-webhook origins), keyed by
   * `meta.id`. `isProspectSource()` classifies a contact's `contacts.source` as
   * a cold prospect origin; the cold posture + write-back travel with each
   * entry. Installed as the process singleton in BOTH the API and worker.
   */
  contactSourceRegistry: ContactSourceRegistry;
  /**
   * The connector OUTBOUND ACTION registry, keyed by `${connectorId}:${name}`.
   * Holds the journey-callable imperative actions (Discord post / broadcast /
   * mention / DM) the standalone `sendConnectorAction()` resolves. Socket-free —
   * independent of any inbound gateway runtime. Empty when none are wired.
   */
  connectorActionRegistry: ConnectorActionRegistry;
  hatchet: HatchetClient;
  /**
   * The client repo's migration journal (`migrations/meta/_journal.json`),
   * powering the `schema.client` block of `GET /v1/health`. Defaults to an
   * empty journal — a client that injects none has a trivially-in-sync client
   * track. The CLIENT track never gates boot (client-owned); engine does.
   */
  clientJournal: JournalShape;
  /**
   * Resolved scheduling + frequency-cap defaults. `timezone` always has a value
   * ("UTC" when unset). Read by the journey context (tz/window) and the mailer
   * (frequency cap).
   */
  defaults: HogsendDefaults;
}

export interface HogsendClientOptions {
  /** Journeys to register in the {@link JourneyRegistry}. Defaults to none. */
  journeys?: DefinedJourney[];
  /** Buckets to register in the {@link BucketRegistry}. Defaults to none. */
  buckets?: DefinedBucket[];
  /**
   * Email lists (D3) to register in the {@link ListRegistry}. Each is a
   * `defineList()` subscription category (id + name + `defaultOptIn`). The
   * registry drives the mailer's list-aware suppression check and the
   * preference center. Defaults to none (empty registry ⇒ legacy opt-in).
   */
  lists?: DefinedList[];
  /**
   * Code-defined one-shot campaigns (broadcasts) — `defineCampaign()` files.
   * Carried on the client so the worker's boot reconciler can schedule them
   * (see `reconcileDefinedCampaigns`); the API process only stores them.
   * Defaults to none.
   */
  campaigns?: DefinedCampaign[];
  /**
   * Email is a first-class channel. Its config is grouped here rather than
   * spread across top-level args — the engine owns the cohesive email pipeline
   * (templates → render → preference checks → tracking → `email_sends` write),
   * and the {@link EmailProvider} is only the swappable wire under it.
   *
   * - `provider` — a single swappable email provider (Resend, Postmark, SES…),
   *   the back-compat one-provider seam. MERGED LAST (after env presets and
   *   `providers`), so it wins on id collision. Tracking/rendering/preferences
   *   come along for free regardless of which provider you supply.
   * - `providers` — register MANY providers into the {@link EmailProviderRegistry}
   *   (e.g. Resend + Postmark) so the `POST /v1/webhooks/email/:providerId`
   *   route can verify each one's webhooks. Merged AFTER the env presets and
   *   BEFORE `provider`.
   * - `defaultProvider` — the active provider id the mailer sends through.
   *   Resolves as `defaultProvider ?? EMAIL_PROVIDER ?? "resend"`. If it names a
   *   provider that isn't registered, the container throws at boot with the list
   *   of registered ids.
   * - `templates` — the app's template registry (key → component + subject +
   *   category), threaded into the engine mailer and onward to
   *   `getTemplate(..., { registry })`. The engine bakes in no business
   *   templates; clients own their `.tsx` files + registry. Defaults to an
   *   empty registry (no sendable template keys).
   *
   * Other channels (SMS, push, Slack) are NOT configured here — they're plain
   * functions a journey imports and calls.
   */
  email?: {
    provider?: EmailProvider;
    providers?: EmailProvider[];
    defaultProvider?: string;
    templates?: TemplateRegistry;
  };
  /**
   * SMS is a first-class channel (the SMS sibling of {@link email}). Its config
   * is grouped here; the engine owns the cohesive SMS pipeline (templates →
   * render → preference/suppression checks → `sms_sends` write → STOP handling),
   * and the {@link SmsProvider} (Twilio, …) is only the swappable wire.
   *
   * - `provider` — a single SMS provider. Merged LAST (after env presets and
   *   `providers`), so it wins on id collision.
   * - `providers` — register MANY providers into the {@link SmsProviderRegistry}
   *   so `POST /v1/webhooks/sms/:providerId` can verify each one's webhooks.
   * - `defaultProvider` — the active provider id the tracked sender delivers
   *   through. Resolves as `defaultProvider ?? SMS_PROVIDER ?? "twilio"`. If it
   *   names an unregistered provider, the container throws at boot.
   * - `templates` — the app's SMS template registry (key → component +
   *   category), threaded into the tracked SMS sender.
   * - `from` — the E.164 default sender (overrides env `SMS_FROM`).
   * - `stopFooter` — the compliance footer appended to non-transactional
   *   bodies; `false` disables it, a string overrides the default text.
   * - `optOutReplies` — send STOP/START/HELP confirmation replies (default off;
   *   the carrier already replies and a post-STOP send is blocked).
   * - `linkTracking` — rewrite bare URLs in rendered bodies to first-party
   *   short tracked links (`/s/:code`). Default true (overrides env
   *   `SMS_LINK_TRACKING`).
   * - `linkHost` — the full origin short links are minted under (overrides
   *   env `SMS_LINK_HOST`; falls back to `API_PUBLIC_URL`).
   *
   * Omitting `sms` entirely (or configuring no provider) installs an inert stub
   * SMS service — an existing deploy without Twilio creds boots unchanged.
   */
  sms?: {
    provider?: SmsProvider;
    providers?: SmsProvider[];
    defaultProvider?: string;
    templates?: SmsTemplateRegistry;
    from?: string;
    stopFooter?: string | false;
    optOutReplies?: boolean;
    linkTracking?: boolean;
    linkHost?: string;
  };
  /**
   * Code-first conversion-point definitions (plan §5.1) — `defineConversion`
   * results. Evaluated inside `ingestEvent` after every fresh event insert;
   * fired instances land in the `conversions` table.
   */
  conversions?: DefinedConversion[];
  /**
   * Conversion DESTINATIONS (plan §5.2) — ad-platform feedback providers
   * (`defineConversionDestination`; Meta CAPI is the reference). Referenced
   * by id from `defineConversion({ destinations })`.
   */
  conversionDestinations?: ConversionDestination[];
  /**
   * CRM sync providers (docs/revenue-attribution-plan.md §4) — the pluggable
   * layer that pushes leads INTO client CRMs and lands pipeline stage changes
   * + deal values back on the event spine as `funnel.stage_changed`. Register
   * one (`provider`) or many (`providers`); each is webhook-served at
   * `POST /v1/webhooks/crm/:providerId` and polled for reconciliation where
   * it implements `poll`. No "active" selection — many CRMs sync at once.
   */
  crm?: {
    provider?: CrmProvider;
    providers?: CrmProvider[];
    /**
     * Per-provider stage maps: native `(pipelineId|'*') → stageId → canonical
     * stage` — the one-CRM-no-funnels 3-liner. Desugars into `crmPipeline`
     * bindings on the synthesized `"default"` funnel. Unmapped stages record
     * native ids and warn (the provider's won/lost status hint still resolves
     * sold/lost). Every mapped value must be a ladder stage or `"lost"` —
     * validated at boot.
     */
    stageMaps?: Record<string, CrmStageMap>;
    /**
     * YOUR canonical funnel's stages, in rank order — replaces the built-in
     * `lead → contacted → survey_booked → quoted → sold`. Same entries as
     * `defineFunnel`: plain strings, or objects carrying `milestone` (and
     * `on` event triggers). All-string arrays get the legacy money defaults
     * (soldStage = last stage, quotedStage = a stage literally named
     * "quoted"); any object entry makes milestones explicit-only. `"lost"`
     * stays the implicit terminal. Zero migration: only new stage events
     * re-rank.
     */
    stages?: FunnelStageEntry[];
  };
  /**
   * Funnels as code-first primitives (§5b.4) — `defineFunnel` results. Each
   * claims CRM traffic via its `bindings` (provider, pipeline) pairs;
   * overlapping claims throw at boot. The `crm.{stages,stageMaps}` group
   * above is sugar for a single `"default"` funnel and composes with these.
   */
  funnels?: DefinedFunnel[];
  /**
   * The analytics provider(s) — provider-neutral since the
   * `AnalyticsProvider` contract (the analytics sibling of `EmailProvider`;
   * PostHog is the reference implementation, not the architecture). Its role
   * is deliberately NARROW — it is NOT the outbound-catalog firing path (the
   * email/contact/journey/bucket lifecycle fans out durably via DESTINATIONS
   * on the webhook spine). The ACTIVE provider serves:
   *
   * 1. The identity PULL — `getPersonProperties` for per-user timezone
   *    resolution at journey enrollment (`define-journey` / `lib/timezone.ts`).
   *    On PostHog this needs `POSTHOG_PERSONAL_API_KEY` (the phc_ project key
   *    is write-only by design); reads soft-fail to contact-property
   *    fallbacks without it.
   * 2. Person WRITES — `setPersonProperties` (the opt-in `bucket.syncToPostHog`
   *    mirror, and trait propagation). Rides the capture pipeline; no extra
   *    credential.
   *
   * Accepted shapes (mirrors `email`):
   * - a group: `{ provider?, providers?, defaultProvider? }` — register one or
   *   many `AnalyticsProvider`s; env presets (`analyticsProvidersFromEnv` —
   *   PostHog when `POSTHOG_API_KEY` is set) merge consumer-LAST;
   *   `defaultProvider` / env `ANALYTICS_PROVIDER` picks the active id
   *   (default `"posthog"`).
   * - a bare `AnalyticsProvider` — registered and made active.
   * - @deprecated a legacy `PostHogService` — wrapped via
   *   `wrapLegacyAnalyticsService` and made active.
   *
   * Lives at the top level (not under `email`) because the engine itself uses
   * it for the PULL.
   */
  analytics?:
    | PostHogService
    | AnalyticsProvider
    | {
        provider?: AnalyticsProvider;
        providers?: AnalyticsProvider[];
        defaultProvider?: string;
        eventMirror?: AnalyticsEventMirrorConfig;
      };
  /**
   * Code-defined outbound DESTINATIONS (Phase 3). Each is a
   * `defineDestination()` delivery-time transform keyed by its `meta.id`, which
   * the delivery task resolves by `webhook_endpoints.kind`. They are MERGED with
   * the env-enabled presets ({@link destinationsFromEnv}): a consumer
   * destination WINS over a preset of the same id (so you can override the
   * shipped `posthog`/`segment`/`slack` shapes). The `webhook` + `posthog`
   * presets are always present, so the no-regression signed-POST path can never
   * be turned off here. Installed as the process registry the self-booting
   * delivery task reads — and `createHogsendClient` runs in BOTH the API and
   * worker, so it is wired in both. Defaults to none (presets only).
   */
  destinations?: DefinedDestination[];
  /**
   * Code-defined inbound CONNECTORS (the unified umbrella). Each is a
   * `defineConnector()` of any transport. MERGED with `connectorsFromEnv` env
   * presets (consumer LAST ⇒ wins on id collision, mirroring destinations). The
   * legacy `webhookSources` array is folded in here as `transport:"webhook"`
   * connectors. Defaults to none.
   */
  connectors?: DefinedConnector[];
  /**
   * Connector OUTBOUND ACTIONS (e.g. `discordActions` from `@hogsend/plugin-discord`)
   * — journey-callable imperative actions registered into the
   * {@link ConnectorActionRegistry} and invoked via the standalone
   * `sendConnectorAction()`. Socket-free; independent of any inbound gateway
   * runtime. Defaults to none.
   */
  connectorActions?: DefinedConnectorAction[];
  /**
   * @deprecated pass `connectors` instead. Back-compat array of
   * `defineWebhookSource()` sources; converted to webhook-transport connectors.
   * Still also accepted by `createApp({ webhookSources })`.
   */
  webhookSources?: DefinedWebhookSource[];
  /**
   * Code-defined CONTACT SOURCES (`defineContactSource()`) — Clay/Attio/generic
   * webhook origins of cold "prospects". Each is lifted onto the webhook-source
   * umbrella (served at `POST /v1/webhooks/:sourceId`, provenance-stamped from
   * `meta.id`) AND registered in the {@link ContactSourceRegistry} so the engine
   * can classify sourced contacts + resolve their cold posture / write-back.
   * Wire in BOTH `index.ts` and `worker.ts`. Defaults to none.
   */
  contactSources?: DefinedContactSource[];
  /**
   * Auto-register the shipped webhook-source PRESETS (Clerk, Supabase, Stripe,
   * Segment) for every preset whose env secret is configured (gated further by
   * `ENABLED_WEBHOOK_PRESETS`). Set `false` to suppress env presets entirely.
   * Default `true`. (Mirrors — and is also honored from — the deprecated
   * `createApp({ enablePresets })` flag, which strips preset ids back out of the
   * registry when set there.)
   */
  enablePresets?: boolean;
  /**
   * Comma-separated ids (or `*`) controlling which journeys load. Defaults to
   * `env.ENABLED_JOURNEYS`.
   */
  enabledJourneys?: string;
  /**
   * Comma-separated ids (or `*`) controlling which buckets load. Defaults to
   * `env.ENABLED_BUCKETS`.
   */
  enabledBuckets?: string;
  /**
   * Comma-separated ids (or `*`) controlling which lists load. Defaults to
   * `env.ENABLED_LISTS`.
   */
  enabledLists?: string;
  /**
   * The client repo's migration journal for the `schema.client` health block.
   * Defaults to `{ entries: [] }` (empty client track ⇒ trivially in sync).
   */
  clientJournal?: JournalShape;
  /**
   * Declarative scheduling + delivery defaults.
   *
   * - `timezone` — global fallback IANA tz (e.g. "UTC"), the terminal step of
   *   the per-user tz resolution chain.
   * - `sendWindow` — quiet-hours window ("HH:mm".."HH:mm") auto-applied by
   *   `ctx.when` so scheduled instants land inside the window. Enforced ONLY at
   *   the scheduling layer; immediate transactional sends bypass it.
   * - `frequencyCap` — per-recipient send cap enforced in the mailer choke
   *   point. Opt-in; "transactional" is exempt by default.
   */
  defaults?: {
    timezone?: TimeZone;
    sendWindow?: SendWindow;
    frequencyCap?: FrequencyCapConfig;
  };
  /**
   * Genuinely advanced / test-only seams. You probably don't need these —
   * prefer the first-class `email` / `analytics` args above.
   * `mailer` replaces the engine-built {@link EmailService} wholesale (used by
   * tests to inject a mock); `auth`, `hatchet`, and `db` swap their respective
   * infrastructure singletons.
   */
  overrides?: {
    mailer?: EmailService;
    auth?: Auth;
    hatchet?: HatchetClient;
    db?: Database;
  };
}

/**
 * Boot-validate ONE email-preference `category` against the resolvable list
 * namespace — shared by both the template loop and the journey loop below so a
 * category typo/consent-flip is caught fail-CLOSED wherever a category is
 * declared. `owner` is the human-readable prefix naming the offending
 * declaration (e.g. `Email template "welcome"` / `Journey "my-journey"`), so the
 * throw/warn messages read naturally for either source.
 *
 * A `category` IS the `email_preferences.categories` key: at send time
 * `lib/tracked.ts` resolves the effective category and `checkSuppression` gates
 * it through `ListRegistry.isSubscribed`, whose legacy fallback is
 * `this.get(id)?.defaultOptIn ?? true`. So an UNKNOWN/typo'd id resolves to the
 * `?? true` opt-in default → treated as subscribed → NOT suppressed → an opt-in/
 * consent email delivered to everyone (CAN-SPAM/GDPR-grade). This guard makes a
 * mismatched category a loud boot failure so it can never reach that fallback.
 *
 * Branch semantics (preserved from the original inline template loop):
 *  - CHANNEL list (`kind:"channel"`) → THROW. A channel gates a delivery
 *    transport, not an email topic; using one as an email category is a category
 *    error (it would also opt-out-gate the send by the connector's channel).
 *  - reserved built-in (`transactional`/`journey`) → OK.
 *  - registered topic list → OK.
 *  - DEFINED but registry-EXCLUDED (ENABLED_LISTS) → THROW for an opt-in list
 *    (excluding it un-gates consent), WARN for an opt-out list (behavior-
 *    preserving, but the preference-center entry is hidden while excluded).
 *  - unknown → THROW.
 */
function validateListCategory(opts: {
  owner: string;
  category: string;
  listRegistry: ListRegistry;
  /** id → `defaultOptIn` for every DEFINED list (`opts.lists`), enabled or not. */
  definedLists: Map<string, boolean>;
  logger: Logger;
}): void {
  const { owner, category, listRegistry, definedLists, logger } = opts;

  // A channel list is a registered list (so `has()`/`isSubscribed` treat it as
  // known), which means the reserved/registered OK branches below would wave it
  // through. Reject it FIRST: a channel gates a delivery transport (the in-app
  // feed, a connector), never an email topic.
  if (listRegistry.isChannel(category)) {
    throw new Error(
      `${owner} uses category "${category}": a channel preference list gates a delivery transport, not an email topic — pick a topic list or a built-in category.`,
    );
  }
  // Reserved built-in category (transactional / journey) — never a list, but a
  // legitimate `email_preferences.categories` key. OK.
  if (isReservedListId(category)) return;
  // Category names a REGISTERED topic list ⇒ suppression/preferences gate
  // correctly. (A `defineList({ enabled:false })` is STILL registered — the
  // registry filters on ENABLED_LISTS only, never `meta.enabled` — so it lands
  // here, not in the excluded branch below.)
  if (listRegistry.has(category)) return;
  // Category names a DEFINED list that is EXCLUDED from the registry by an
  // ENABLED_LISTS allowlist that doesn't name it. Excluding it makes the
  // send-time check fall back to the legacy `?? true` opt-in default, which
  // FLIPS the gate by polarity:
  //   • opt-IN list (`defaultOptIn:false`, consent required): enabled →
  //     `categories[id] === true` (never-consented = NOT subscribed =
  //     suppressed); excluded → `categories[id] !== false` (never-consented =
  //     SUBSCRIBED = NOT suppressed) → the consent email SHIPS to someone who
  //     never opted in. Disabling un-gates consent → THROW (fail closed).
  //   • opt-OUT list (`defaultOptIn:true`): both enabled and excluded compute
  //     `categories[id] !== false` — IDENTICAL, behavior-preserving → WARN.
  const definedOptIn = definedLists.get(category);
  if (definedOptIn !== undefined) {
    if (definedOptIn === false) {
      throw new Error(
        `${owner} has category "${category}", an OPT-IN email list (defaultOptIn:false) that is DEFINED but EXCLUDED from the active registry by ENABLED_LISTS. At send time an excluded list falls back to the legacy opt-in default, which UN-GATES consent — the opt-in email would ship to recipients who never subscribed. Re-enable the list in ENABLED_LISTS (or change the category) — disabling an opt-in list must not silently flip its consent gate open.`,
      );
    }
    logger.warn(
      `${owner} has category "${category}", a DEFINED email list EXCLUDED from the active registry by ENABLED_LISTS. It is an opt-out list (defaultOptIn:true), so send-time gating is behavior-preserving — but its preference center entry is hidden while excluded. Re-enable the list in ENABLED_LISTS or change the category.`,
    );
    return;
  }
  // Unknown category: neither a reserved built-in nor a defined list. At send
  // time this resolves to the `?? true` opt-in default, bypassing suppression/
  // consent. Fail CLOSED with an actionable message.
  const knownLists = [...definedLists.keys()];
  throw new Error(
    `${owner} has category "${category}", which is neither a reserved built-in category (${[
      ...RESERVED_LIST_IDS,
    ].join(", ")}) nor a defined email list (${
      knownLists.length ? knownLists.join(", ") : "none"
    }). A category is its email-preferences list key, so it MUST match a list id (defineList) or a reserved built-in — otherwise an unknown/typo'd category silently defaults to opt-in and un-gates suppression/consent. Fix the category or define the list.`,
  );
}

/**
 * The inert SMS service installed when no SMS provider is configured. `render`
 * still works (templates need no provider); `send` throws an actionable error;
 * `handleWebhook` is a no-op (a stray webhook can't dispatch without a provider).
 */
function createStubSmsService(): SmsService {
  const notConfigured = () => {
    throw new Error(
      "No SMS provider configured. Set TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN and SMS_FROM, or pass sms.provider to createHogsendClient.",
    );
  };
  return {
    async send() {
      return notConfigured();
    },
    async sendRaw() {
      return notConfigured();
    },
    async render() {
      return notConfigured();
    },
    async handleWebhook(event) {
      return { type: event.type, handled: false };
    },
  };
}

export function createHogsendClient(
  opts: HogsendClientOptions = {},
): HogsendClient {
  const logger = createLogger(env.LOG_LEVEL);
  const created = createDatabase({ url: env.DATABASE_URL });
  const db = opts.overrides?.db ?? created.db;

  // Resolve buckets + their reaction journeys BEFORE the journey registry so the
  // reaction ids (`bucket-<id>-on-<kind>`, registered separately below) are part
  // of ENABLED_JOURNEYS's known set. They ARE registered journeys, so listing a
  // real reaction id in ENABLED_JOURNEYS must NOT be rejected as a typo.
  const buckets = opts.buckets ?? [];
  const enabledBuckets = opts.enabledBuckets ?? env.ENABLED_BUCKETS;
  const reactionJourneys = collectBucketReactionJourneys(
    buckets,
    enabledBuckets,
  );

  const registry = buildJourneyRegistry(
    opts.journeys ?? [],
    opts.enabledJourneys ?? env.ENABLED_JOURNEYS,
    reactionJourneys.map((r) => r.meta.id),
  );

  // Installs the bucket registry singleton in BOTH the API and worker processes
  // (both call createHogsendClient); the real-time ingest path reads it via
  // getBucketRegistrySingleton().
  const bucketRegistry = buildBucketRegistry(buckets, enabledBuckets);

  // Register the reaction journeys generated by `bucket.on()` into the journey
  // registry AFTER buildJourneyRegistry, bypassing the ENABLED_JOURNEYS filter:
  // reactions are bucket-owned and were already gated by ENABLED_BUCKETS
  // (collectBucketReactionJourneys), so their `bucket-<id>-on-<kind>` ids must NOT
  // be subject to the journeys csv (Section 9). Both API and worker call
  // createHogsendClient, so the singleton carries reaction metas in both
  // processes (needed for admin feedsJourneys + the dwell-cron lookup).
  for (const reaction of reactionJourneys) {
    registry.register(reaction.meta);
  }

  // Re-bind the member-access accessors on each enabled bucket to THIS
  // container's db so `overrides.db` flows through (the accessors default to the
  // getDb() singleton at defineBucket time, before any container exists —
  // bucket-access.ts dbResolver seam). The enabled set mirrors
  // buildBucketRegistry's filter.
  const enabledIds = new Set(bucketRegistry.getAll().map((b) => b.id));
  for (const bucket of buckets) {
    if (!enabledIds.has(bucket.meta.id)) continue;
    const accessor = createBucketAccessor(bucket.meta.id, () => db);
    bucket.count = accessor.count;
    bucket.has = accessor.has;
    bucket.members = accessor.members;
    bucket.membersIterator = accessor.membersIterator;
  }

  // Build + install the list registry singleton (D3). Runs in BOTH the API and
  // worker (both call createHogsendClient), so `getListRegistry()` resolves the
  // wired lists in the mailer's suppression check and the preference center in
  // either process. `buildListRegistry` installs the process singleton.
  //
  // Channel lists (the in-app feed + one per connector exposing member-directed
  // actions) are synthesized from the raw `opts.connectorActions` array — which
  // is available here before the connector-action registry is built, and is
  // identical in both the API and worker processes — then registered
  // unconditionally (bypassing ENABLED_LISTS) after the user lists.
  // Build the SMS provider registry early (before channel synthesis) so the
  // `sms` opt-out channel is minted iff an SMS provider is actually configured.
  // Same merge order as email: env presets FIRST, then `providers`, then the
  // single `provider` LAST (last-writer-wins).
  const smsProviders = new SmsProviderRegistry([
    ...smsProvidersFromEnv(env),
    ...(opts.sms?.providers ?? []),
    ...(opts.sms?.provider ? [opts.sms.provider] : []),
  ]);
  const smsConfigured = smsProviders.count() > 0;

  // CRM sync providers (§Phase 4). No env presets yet — CRM credentials are
  // per-deployment enough that construction stays consumer-side; the single
  // `provider` merges LAST (wins an id collision with `providers`).
  const crmProviders = new CrmProviderRegistry([
    ...(opts.crm?.providers ?? []),
    ...(opts.crm?.provider ? [opts.crm.provider] : []),
  ]);
  // Funnels (§5b.4): authored `defineFunnel`s plus a synthesized "default"
  // carrying the crm.{stages,stageMaps} sugar — unless the consumer authored
  // their own default. The sugar desugars THROUGH defineFunnel itself (one
  // normalization + validation path: ladder rules, milestone rules, binding
  // targets). The registry ctor throws on overlapping pipeline claims and
  // duplicate ids.
  const authoredFunnels = opts.funnels ?? [];
  const authoredDefault = authoredFunnels.some(
    (f) => f.meta.id === DEFAULT_FUNNEL_ID,
  );
  const crmSugarPresent = Boolean(opts.crm?.stages || opts.crm?.stageMaps);
  if (authoredDefault && crmSugarPresent) {
    logger.warn(
      'crm.{stages,stageMaps} are IGNORED because a funnel with id "default" is authored — move that config into the funnel',
    );
  }
  const defaultFunnel = authoredDefault
    ? undefined
    : defineFunnel({
        id: DEFAULT_FUNNEL_ID,
        stages: opts.crm?.stages ?? [...DEFAULT_PIPELINE_LADDER.stages],
        bindings: Object.entries(opts.crm?.stageMaps ?? {}).flatMap(
          ([providerId, map]) =>
            Object.entries(map).map(([pipelineId, stages]) =>
              crmPipeline({
                provider: providerId,
                pipeline: pipelineId,
                stages,
              }),
            ),
        ),
      });
  const funnels = new FunnelRegistry([
    ...authoredFunnels,
    ...(defaultFunnel ? [defaultFunnel] : []),
  ]);

  // Process singleton for the crm-reconcile cron (runs in BOTH API and worker;
  // the cron reads it because task fns have no client reference).
  setCrmSyncConfig({
    registry: crmProviders,
    funnels,
  });

  // Conversion-point registry (plan §5.1) — evaluated on every ingest in BOTH
  // the API and worker processes.
  // Zero-config revenue conversion (impact plan §5.2) — seeded unless the
  // consumer authors their own `id: "revenue"` definition or opts out via
  // HOGSEND_DEFAULT_REVENUE_CONVERSION=false (the seeded-PostHog-destination
  // opt-out pattern).
  const authoredConversions = opts.conversions ?? [];
  const seedDefaultRevenue =
    process.env.HOGSEND_DEFAULT_REVENUE_CONVERSION !== "false" &&
    !authoredConversions.some((def) => def.meta.id === "revenue");
  setConversionRegistry(
    new ConversionRegistry(
      seedDefaultRevenue
        ? [...authoredConversions, defaultRevenueConversion]
        : authoredConversions,
    ),
  );
  setConversionDestinations(
    new ConversionDestinationRegistry(opts.conversionDestinations ?? []),
  );
  // The durable dispatch task reference (composition root — the lib module
  // cannot import the workflow without a cycle). Left UNSET under a hatchet
  // override so tests never touch real gRPC; dispatch rows stay pending.
  if (!opts.overrides?.hatchet) {
    setConversionDispatchTask(dispatchConversionTask);
  }

  const channelLists = synthesizeChannelLists(opts.connectorActions ?? [], {
    sms: smsConfigured,
  });
  const listRegistry = buildListRegistry(
    opts.lists ?? [],
    opts.enabledLists ?? env.ENABLED_LISTS,
    channelLists,
  );

  // Build the email provider registry, then resolve the single active provider
  // the mailer sends through. Merge order is load-bearing (consumer last/wins,
  // mirroring the destinations merge): env presets FIRST, then
  // `opts.email.providers`, then the single back-compat `opts.email.provider`
  // LAST — so a consumer-supplied provider overrides an env preset of the same
  // id (last-writer-wins on the registry). The registry is what the
  // `POST /v1/webhooks/email/:providerId` route dispatches by id.
  const emailProviders = new EmailProviderRegistry([
    ...emailProvidersFromEnv(env),
    ...(opts.email?.providers ?? []),
    ...(opts.email?.provider ? [opts.email.provider] : []),
  ]);

  // The active provider id the mailer sends through:
  // `defaultProvider ?? EMAIL_PROVIDER ?? "resend"`. The default Resend provider
  // is built (when RESEND_API_KEY is set) by `emailProvidersFromEnv` above — the
  // SINGLE place Resend is constructed from env — so resolution is just a
  // registry lookup that throws if the active id resolves to nothing. NEVER
  // silently fall back for a non-resend id.
  const explicitId = opts.email?.defaultProvider ?? env.EMAIL_PROVIDER;
  const activeId = explicitId ?? "resend";
  let provider = emailProviders.get(activeId);

  if (!provider) {
    // An EXPLICITLY requested id that resolves to nothing is a config error —
    // throw (typo safety). So is an implicit default when OTHER providers are
    // registered (e.g. Postmark-only without EMAIL_PROVIDER=postmark).
    if (explicitId !== undefined || emailProviders.count() > 0) {
      throw new Error(
        `email provider "${activeId}" is not registered (registered: ${emailProviders
          .getAll()
          .map((p) => p.meta?.id ?? "resend")
          .join(", ")})`,
      );
    }
    // Zero providers + nothing requested = a fresh app without email creds
    // yet. Boot INERT instead of crashing (mirrors the SMS channel's
    // operator-opt-in stub): Studio, ingest and non-email journeys all work;
    // each send fails per-call with an actionable message. The stub is NOT
    // registered in the registry, so no webhook route resolves it.
    provider = createUnconfiguredEmailProvider();
    logger.warn(
      "no email provider configured — email sends will fail until RESEND_API_KEY (or POSTMARK_SERVER_TOKEN with EMAIL_PROVIDER=postmark) is set. Everything else works without one.",
    );
  }

  // Tracking sovereignty: first-party open/click tracking is the single source
  // of truth. A provider that can't force its OWN tracking off per-send (an
  // account-level toggle — e.g. Resend) declares `nativeTracking: true`. We
  // can't reach that toggle, so we WARN at boot. The outbound-echo suppression
  // in `dispatchWebhook` is the defence: a native open/click webhook only
  // touches DB status, never re-emits outbound.
  if (provider.capabilities?.nativeTracking === true) {
    logger.warn(
      `provider ${
        provider.meta?.id ?? "resend"
      } can't disable its native open/click tracking per-send (account-level setting) — if it's enabled in the provider dashboard, turn it off there; first-party tracking is Hogsend's source of truth.`,
    );
  }

  // Cached sending-domain status for the active provider. Constructed right
  // after provider resolution so it binds the SAME provider the mailer sends
  // through. One non-blocking warm-up refresh primes the cache at boot —
  // fire-and-forget, swallowed errors, must never block or fail boot. Skipped
  // under NODE_ENV=test so test runs stay hermetic (no real provider HTTP).
  const domainStatus = createDomainStatusService({ provider, env, logger });
  if (env.NODE_ENV !== "test") {
    domainStatus.refreshIfStale();
  }

  const defaults: HogsendDefaults = {
    timezone: opts.defaults?.timezone ?? "UTC",
    sendWindow: opts.defaults?.sendWindow,
    frequencyCap: opts.defaults?.frequencyCap,
  };

  // Expose the scheduling slice to the module-level journey task, which has no
  // client reference of its own.
  setClientScheduleDefaults({
    timezone: defaults.timezone,
    sendWindow: defaults.sendWindow,
  });

  const templates = opts.email?.templates ?? ({} as TemplateRegistry);

  // Boot-validate every template's `category` against the resolvable list
  // namespace BEFORE the mailer/emailService is constructed — fail CLOSED.
  //
  // A template's `category` (TemplateDefinition.category) IS the
  // email-preferences list key: at send time `lib/tracked.ts` resolves the
  // effective category and `checkSuppression` gates it through
  // `ListRegistry.isSubscribed`, whose `isSubscribedByDefault` legacy fallback
  // is `this.get(id)?.defaultOptIn ?? true`. So a TYPO'd category (e.g.
  // "product-update" when the opt-in list id is "product-updates") resolves to
  // an UNKNOWN id → `?? true` opt-in default → treated as subscribed → NOT
  // suppressed. The consent/opt-in email would then be delivered to EVERY
  // recipient (including never-subscribed) AND anyone who unsubscribed under the
  // correct key would still receive it — CAN-SPAM/GDPR-grade. This guard makes a
  // mismatched category a loud boot failure so it can never reach that fallback.
  //
  // Known-good set = reserved built-ins ∪ DEFINED lists (`opts.lists`), NOT just
  // the ENABLED registry — mirroring the ENABLED_JOURNEYS lesson (validate
  // against DEFINED, not just ENABLED). A DEFINED-but-registry-EXCLUDED list
  // (removed from the registry by an ENABLED_LISTS allowlist that doesn't name
  // it) does NOT auto-warn: excluding it flips the send-time gate by POLARITY,
  // so we branch on `defaultOptIn` (below). We carry each list's `defaultOptIn`
  // (not just its id) so that branch can decide THROW vs WARN. This does NOT
  // change the send-time suppression logic; it only prevents a bad/consent-
  // flipping category reaching it.
  const definedLists = new Map(
    (opts.lists ?? []).map((l) => [l.meta.id, l.meta.defaultOptIn] as const),
  );
  for (const [templateKey, def] of Object.entries(templates)) {
    const category = (def as TemplateDefinition | undefined)?.category;
    // No category ⇒ no per-list gating for this template; nothing to validate.
    if (!category) continue;
    validateListCategory({
      owner: `Email template "${templateKey}"`,
      category,
      listRegistry,
      definedLists,
      logger,
    });
  }

  // Boot-validate every journey's `meta.category` through the SAME helper (same
  // fail-closed branch semantics as templates). A journey stamps its category on
  // every `sendEmail` at send time (overriding the template's own category), so
  // a typo/channel/consent-flip here is exactly as dangerous as on a template.
  // Bucket-reaction journeys never carry a `category`, so `opts.journeys` is the
  // complete set to check. Placed right beside the template loop.
  for (const journey of opts.journeys ?? []) {
    const category = journey.meta.category;
    if (!category) continue;
    validateListCategory({
      owner: `Journey "${journey.meta.id}"`,
      category,
      listRegistry,
      definedLists,
      logger,
    });
  }

  const emailService =
    opts.overrides?.mailer ??
    createTrackedMailer(
      {
        defaultFrom: env.EMAIL_FROM ?? env.RESEND_FROM_EMAIL,
        templates,
        db,
        bounceThreshold: 3,
        baseUrl: env.API_PUBLIC_URL,
        frequencyCap: defaults.frequencyCap,
        logger,
      },
      {
        provider,
        prepareTrackedHtml,
        // Test-mode redirect: the mailer reads `domainStatus.testModeCached()`
        // (sync, cache-only) per send to decide whether to redirect to the safe
        // inbox. Constructed above (right after provider resolution) so it binds
        // the SAME active provider the mailer sends through.
        domainStatus,
      },
    );

  setEmailService(emailService);

  // --- SMS channel (parallel to the email pipeline above) -------------------
  // Resolve the active SMS provider: `defaultProvider ?? SMS_PROVIDER ?? "twilio"`.
  // An EXPLICITLY-requested id that isn't registered throws (mirrors email's
  // "never silently fall back"). When nothing is configured the registry is
  // empty and `smsProvider` stays undefined — the tracked sender below becomes
  // an inert stub so an existing deploy without Twilio creds boots unchanged.
  const smsTemplates = opts.sms?.templates ?? ({} as SmsTemplateRegistry);
  const smsActiveId = opts.sms?.defaultProvider ?? env.SMS_PROVIDER ?? "twilio";
  const smsExplicit = Boolean(opts.sms?.defaultProvider ?? env.SMS_PROVIDER);
  let smsProvider = smsProviders.get(smsActiveId);
  // DX: when the active id wasn't explicitly requested and the default "twilio"
  // isn't registered but EXACTLY ONE provider is, use that one — so a consumer
  // passing a single `sms.provider` (any id) never has to also set
  // `defaultProvider`. An explicit id that misses still throws below.
  if (!smsProvider && !smsExplicit && smsProviders.count() === 1) {
    smsProvider = smsProviders.getAll()[0];
  }
  if (smsExplicit && !smsProvider) {
    throw new Error(
      `SMS provider "${smsActiveId}" is not registered (registered: ${
        smsProviders
          .getAll()
          .map((p) => p.meta.id)
          .join(", ") || "none"
      }). Set TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN and SMS_FROM, or pass sms.provider.`,
    );
  }

  // Boot-validate SMS template categories through the SAME fail-closed helper as
  // email templates (a channel/typo/consent-flip category is as dangerous here).
  for (const [templateKey, def] of Object.entries(smsTemplates)) {
    const category = (def as SmsTemplateDefinition | undefined)?.category;
    if (!category) continue;
    validateListCategory({
      owner: `SMS template "${templateKey}"`,
      category,
      listRegistry,
      definedLists,
      logger,
    });
  }

  const smsService: SmsService = smsProvider
    ? createTrackedSmsSender(
        {
          defaultFrom: opts.sms?.from ?? env.SMS_FROM,
          templates: smsTemplates,
          db,
          frequencyCap: defaults.frequencyCap,
          logger,
          stopFooter: opts.sms?.stopFooter,
          optOutReplies: opts.sms?.optOutReplies,
          // Deploy-wide test-mode coherence: HOGSEND_TEST_MODE is channel-
          // neutral. "true" forces SMS test mode directly; "auto" arms it
          // whenever the EMAIL side's test mode is armed (unverified domain),
          // so a staging deploy that redirects email never live-texts real
          // numbers. SMS has no domain-verification analog of its own, so
          // "auto" with email test mode off keeps live sends (PR behavior).
          testMode: () =>
            env.HOGSEND_TEST_MODE === "true" ||
            (env.HOGSEND_TEST_MODE === "auto" &&
              domainStatus.testModeCached().active),
          testPhone: env.HOGSEND_TEST_PHONE,
          // First-party short-link rewriting (ON by default, mirrors email's
          // always-on tracking). SMS_LINK_HOST swaps in a branded short
          // domain; API_PUBLIC_URL serves out of the box.
          linkTracking:
            opts.sms?.linkTracking ?? env.SMS_LINK_TRACKING !== "false",
          linkHost: (
            opts.sms?.linkHost ??
            env.SMS_LINK_HOST ??
            env.API_PUBLIC_URL
          ).replace(/\/+$/, ""),
        },
        { provider: smsProvider },
      )
    : createStubSmsService();

  setSmsService(smsService);

  // Wire better-auth's secondary storage to the SHARED engine Redis (the same
  // singleton backing the PostHog cache + worker heartbeat — never a second
  // pool). Passing `secondaryStorage` flips better-auth's rate-limit store from
  // the per-instance in-memory default to this shared store, so the sign-in /
  // request-password-reset limiters are enforced ACROSS Railway replicas and
  // survive restarts (security finding #2).
  //
  // Gate on the RAW `process.env.REDIS_URL`, NOT `env.REDIS_URL`: the latter
  // carries a `redis://localhost:6379` zod default, so it is never empty and
  // would wire secondary storage unconditionally. When an operator hasn't set
  // REDIS_URL we deliberately keep better-auth's in-memory store rather than
  // pushing SESSIONS into a Redis that may not exist — a wired secondaryStorage
  // degrades `get` to null on a fault, which for sessions means silent
  // logouts. `getRedis()` is lazyConnect, so this stays synchronous (no
  // connection until the first auth command); on a transient Redis fault the
  // adapter degrades to a no-op rather than failing the auth flow.
  const authSecondaryStorage = process.env.REDIS_URL
    ? createRedisSecondaryStorage(getRedis())
    : undefined;

  // Auth is built AFTER the mailer so we can wire the self-service password-reset
  // delivery to the just-built `emailService` directly (rather than relying on a
  // singleton resolved at request time). The injected `sendResetPassword` is what
  // flips better-auth's reset endpoints from disabled → live; the engine-owned,
  // self-contained reset email needs no consumer template wiring, so reset works
  // on a bare instance. NEVER log the url/token (see `sendResetPasswordEmail`).
  const auth =
    opts.overrides?.auth ??
    createAuth({
      db,
      secret: env.BETTER_AUTH_SECRET,
      baseURL: env.BETTER_AUTH_URL,
      // Give the engine (Studio/dogfood, e.g. t.hogsend.com) its OWN cookie
      // namespace so its session cookie stops colliding with a sibling web
      // app's `.hogsend.com` cross-subdomain SSO cookie. Env default is
      // "hogsend"; no deploy needs to set AUTH_COOKIE_PREFIX explicitly.
      cookiePrefix: env.AUTH_COOKIE_PREFIX,
      secondaryStorage: authSecondaryStorage,
      // Always trust the public API origin; add any explicitly configured ones
      // (e.g. a remote Studio origin) on top. baseURL is trusted automatically.
      trustedOrigins: Array.from(
        new Set(
          [
            env.API_PUBLIC_URL,
            ...(env.BETTER_AUTH_TRUSTED_ORIGINS?.split(",") ?? []),
          ]
            .map((o) => o.trim())
            .filter(Boolean),
        ),
      ),
      sendResetPassword: async ({ user, url }) => {
        await sendResetPasswordEmail({
          to: user.email,
          url,
          emailService,
          logger,
        });
      },
    });

  // Resolve the analytics provider(s) — mirrors the email-provider shape:
  // env presets first, consumer registrations LAST (last-writer-wins), then
  // ONE active provider picked by id. The deprecated bare-PostHogService and
  // bare-AnalyticsProvider forms register-and-activate directly.
  const analyticsOpt = opts.analytics;
  const analyticsGroup =
    analyticsOpt &&
    !isAnalyticsProvider(analyticsOpt as AnalyticsProvider) &&
    typeof (analyticsOpt as PostHogService).captureEvent !== "function"
      ? (analyticsOpt as {
          provider?: AnalyticsProvider;
          providers?: AnalyticsProvider[];
          defaultProvider?: string;
          eventMirror?: AnalyticsEventMirrorConfig;
        })
      : undefined;

  const analyticsProviders = new AnalyticsProviderRegistry([
    ...analyticsProvidersFromEnv(env, { db, logger }),
    ...(analyticsGroup?.providers ?? []),
    ...(analyticsGroup?.provider ? [analyticsGroup.provider] : []),
  ]);

  let analytics: AnalyticsProvider | undefined;
  if (analyticsOpt && !analyticsGroup) {
    // Bare provider or legacy service: register and activate it directly.
    analytics = isAnalyticsProvider(analyticsOpt as AnalyticsProvider)
      ? (analyticsOpt as AnalyticsProvider)
      : wrapLegacyAnalyticsService(analyticsOpt as PostHogService);
    analyticsProviders.register(analytics);
  } else {
    // Resolve the ONE active analytics provider by id — the analytics sibling of
    // the email-provider resolution above, and fail loud on an unresolved
    // active id exactly like `EMAIL_PROVIDER` does. `env.ANALYTICS_PROVIDER`
    // carries a zod `.default("posthog")`, so the resolved id is never empty —
    // that default is what AUTO-ACTIVATES the PostHog env preset when
    // `POSTHOG_API_KEY` is set. Because of that default we must NOT fail boot
    // merely because the resolved id is unregistered: an operator who wired NO
    // analytics still resolves "posthog" and legitimately has no provider (leave
    // `analytics` undefined — reads/mirror stay no-ops). So the throw is gated on
    // the id being EXPLICITLY requested — a code `defaultProvider` OR a SET
    // `ANALYTICS_PROVIDER` env. The RAW `process.env` read (mirroring the
    // `REDIS_URL` read above) is what distinguishes an explicit request from the
    // zod default; without this gate a bogus `ANALYTICS_PROVIDER` typo would
    // SILENTLY disable analytics (killing tz person-reads + the event mirror)
    // instead of failing loud.
    const activeId = analyticsGroup?.defaultProvider ?? env.ANALYTICS_PROVIDER;
    const explicitlyRequested = Boolean(
      analyticsGroup?.defaultProvider ?? process.env.ANALYTICS_PROVIDER,
    );
    analytics = analyticsProviders.get(activeId);
    if (explicitlyRequested && !analytics) {
      throw new Error(
        `analytics provider "${activeId}" is not registered (registered: ${analyticsProviders
          .getAll()
          .map((p) => p.meta.id)
          .join(", ")})`,
      );
    }
  }

  // Person reads need a privileged credential on most platforms (PostHog: a
  // personal API key — the phc_ project key is write-only by design). Surface
  // the degraded mode once at boot instead of letting tz resolution silently
  // fall back for months.
  // OAuth-capable providers resolve their credential ASYNC (the env factory
  // logs the truthful nudge after the load settles) — a sync check here would
  // log a false "DISABLED" on every boot of a connected instance.
  if (
    analytics &&
    !analytics.capabilities.oauth &&
    !analytics.capabilities.personReads
  ) {
    logger.info(
      `analytics provider "${analytics.meta.id}" has person reads DISABLED — ` +
        "timezone resolution falls back to contact properties. For PostHog, " +
        "set POSTHOG_PERSONAL_API_KEY or run `hogsend connect posthog`. " +
        "Docs: https://hogsend.com/docs/guides/analytics-access",
    );
  }

  // Expose the resolved analytics instance to the module-level task-execution
  // sites that have no client reference. Its role is NARROW (see the
  // `analytics?` option doc): the identity PULL (`getPersonProperties` for tz
  // resolution in the journey durable task) plus person writes (the opt-in
  // `bucket.syncToPostHog` mirror) — NOT the outbound catalog firing path
  // (that is the destinations spine). `createHogsendClient` runs in both the
  // API and worker, so this is installed before any worker task runs. May be
  // undefined (no provider configured) — the reads stay no-ops.
  setAnalytics(analytics);

  // Event mirror (operator policy): resolve the ingest→analytics capture config
  // once and install it on the same singleton seam as `analytics`, so
  // `ingestEvent` mirrors events into the active provider on EVERY ingest path
  // (not just the routes that thread `analytics`). Off by default. The env flag
  // is an explicit OVERRIDE in both directions when set ("true"/"false"); unset
  // ⇒ the code option wins. Allow/deny stay code-only (env is not list config).
  const eventMirror: AnalyticsEventMirrorConfig = {
    enabled:
      env.ANALYTICS_EVENT_MIRROR != null
        ? env.ANALYTICS_EVENT_MIRROR === "true"
        : (analyticsGroup?.eventMirror?.enabled ?? false),
    allow: analyticsGroup?.eventMirror?.allow,
    deny: analyticsGroup?.eventMirror?.deny,
  };
  setAnalyticsEventMirror(eventMirror);

  // Identity-attach helper (§7): bound to THIS container's db + resolved
  // analytics provider so a contact-merge outside the `/v1/events` ingest path
  // (Discord `/link`) propagates the analytics merge through the same engine
  // emission ingest uses. Closes over `analytics` (may be undefined → the merge
  // emission no-ops; the resolve still happens).
  const identity = createIdentityService({ db, analytics, logger });

  // Build + install the outbound DESTINATION registry (Phase 3) the
  // self-booting delivery task resolves by `webhook_endpoints.kind`. Order is
  // load-bearing: the env-enabled presets come FIRST and the consumer's
  // `opts.destinations` LAST, so the DestinationRegistry's last-writer-wins map
  // lets a consumer destination override a shipped preset of the same id. Runs
  // in BOTH the API and worker (both call createHogsendClient), so the registry
  // is present before any worker delivery task executes.
  const destinations = [
    ...destinationsFromEnv(env),
    ...(opts.destinations ?? []),
  ];
  const destinationRegistry = new DestinationRegistry(destinations);
  setDestinationRegistry(destinationRegistry);

  // Build + install the unified inbound CONNECTOR registry — the structural
  // twin of the destination registry above. Order is load-bearing (consumer
  // last/wins, mirroring destinations): env presets FIRST (gated by
  // `enablePresets`), then legacy `webhookSources` lifted onto the umbrella,
  // then the first-class `connectors` LAST. Runs in BOTH the API and worker.
  // The webhook route reads `getByTransport("webhook")`; the generic
  // `/v1/connectors/:id/*` routes read `get(id).handlers`. The `email`
  // reserved-id guard is the authoritative one (the route reads the registry).
  const enablePresets = opts.enablePresets ?? true;
  const connectorList = [
    ...(enablePresets ? connectorsFromEnv(env) : []),
    ...(opts.webhookSources ?? []).map(webhookSourceToConnector),
    // Contact sources ride the SAME webhook path (provenance stamped from
    // meta.id); lift to a webhook source, then onto the connector umbrella.
    ...(opts.contactSources ?? [])
      .map(contactSourceToWebhookSource)
      .map(webhookSourceToConnector),
    ...(opts.connectors ?? []),
  ];
  for (const connector of connectorList) {
    if (
      (connector.meta.transport ?? "webhook") === "webhook" &&
      (connector.meta.id === "email" ||
        connector.meta.id === "sms" ||
        connector.meta.id === "crm")
    ) {
      throw new Error(
        `Connector id "${connector.meta.id}" is reserved for the ` +
          "email/SMS/CRM-provider routes (POST /v1/webhooks/{email,sms,crm}/:providerId). " +
          "Rename the connector.",
      );
    }
  }
  const connectorRegistry = new ConnectorRegistry(connectorList);
  setConnectorRegistry(connectorRegistry);
  logger.debug(
    `Connector registry loaded: ${connectorRegistry.count()} connectors`,
  );

  // Build + install the contact-source registry (prospect classification + cold
  // posture + write-back), keyed by meta.id. Runs in BOTH the API and worker.
  const contactSourceRegistry = buildContactSourceRegistry(
    opts.contactSources ?? [],
  );

  // Fail-loud at boot on a contact source with no secret: a `match` auth is OPEN
  // when the env value is empty, which for a contact source means an
  // UNAUTHENTICATED identity-write endpoint (it mints/enriches contacts and can
  // trigger outbound journeys). Warn so the operator catches the omission before
  // it ships. Mirrors the webhook route's secret resolution (env ?? process.env).
  for (const src of opts.contactSources ?? []) {
    if (src.auth.type !== "match") continue;
    const secret =
      (env[src.auth.envKey as keyof typeof env] as string | undefined) ??
      process.env[src.auth.envKey];
    if (!secret) {
      logger.warn(
        `Contact source "${src.meta.id}" has no secret set (env ${src.auth.envKey}) — ` +
          "its webhook currently accepts UNAUTHENTICATED contact writes. Set the secret.",
      );
    }
  }

  // Build + install the connector ACTION registry (outbound imperative actions),
  // the action sibling of the connector registry above. Runs in BOTH the API and
  // worker (both call createHogsendClient), so `sendConnectorAction()` resolves
  // in either process.
  const connectorActionRegistry = new ConnectorActionRegistry(
    opts.connectorActions ?? [],
  );
  setConnectorActionRegistry(connectorActionRegistry);

  // Optional: auto-seed a PostHog DESTINATION on the outbound spine so the email
  // lifecycle fans out to PostHog durably. Default OFF (ENABLE_POSTHOG_DESTINATION)
  // to avoid double-emit alongside the fire-and-forget capture path. Idempotent +
  // fire-and-forget — a seed failure must never block boot. Runs in BOTH the API
  // and worker (both call createHogsendClient); the dup guard makes the second a
  // no-op.
  if (env.ENABLE_POSTHOG_DESTINATION && env.POSTHOG_API_KEY) {
    void seedPostHogDestination({
      db,
      logger,
      apiKey: env.POSTHOG_API_KEY,
      host: env.POSTHOG_HOST,
    }).catch((error: unknown) => {
      logger.warn("seedPostHogDestination failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  // Counts are surfaced by the boot banner / structured ready log (lib/boot.ts);
  // keep these at debug for non-boot contexts (tests, REPL, library use).
  logger.debug(`Journey registry loaded: ${registry.count()} journeys`);
  logger.debug(`Bucket registry loaded: ${bucketRegistry.count()} buckets`);
  logger.debug(`List registry loaded: ${listRegistry.count()} lists`);
  logger.debug(
    `Destination registry loaded: ${destinationRegistry.count()} destinations`,
  );

  const client: HogsendClient = {
    env,
    logger,
    db,
    dbClient: created.client,
    auth,
    emailService,
    emailProviders,
    emailProvider: provider,
    domainStatus,
    templates,
    smsService,
    smsProviders,
    smsProvider,
    crmProviders,
    funnels,
    analyticsProviders,
    analytics,
    identity,
    registry,
    journeySources: getJourneySources(),
    journeySourceLocations: getJourneySourceLocations(),
    bucketRegistry,
    listRegistry,
    campaigns: opts.campaigns ?? [],
    connectorRegistry,
    contactSourceRegistry,
    connectorActionRegistry,
    hatchet: opts.overrides?.hatchet ?? hatchet,
    clientJournal: opts.clientJournal ?? { entries: [] },
    defaults,
  };

  // Boot-time reader for `hogsend connect posthog`'s persisted phc_: when no
  // provider resolved AND no POSTHOG_API_KEY is set, activate PostHog from the
  // stored derived credential (async, fire-and-forget — the container is built
  // synchronously; a failure leaves the container exactly as booted). ALL
  // activation effects live here, in one block, so "who mutates what" has a
  // single answer. Skipped under NODE_ENV=test so suites stay hermetic.
  if (!analytics && !env.POSTHOG_API_KEY && env.NODE_ENV !== "test") {
    void buildStoredPosthogProvider({ env, db, logger })
      .then((provider) => {
        if (!provider) return;
        // Someone claimed the slot while we read (consumer provider, race).
        if (client.analytics || analyticsProviders.get("posthog")) return;
        analyticsProviders.register(provider);
        client.analytics = provider;
        setAnalytics(provider);
        // Rebuild the boot closure that captured `analytics: undefined` so
        // identity merges propagate to the newly-live provider too.
        client.identity = createIdentityService({
          db,
          analytics: provider,
          logger,
        });
        logger.info(
          'analytics provider "posthog" activated from the stored `hogsend connect posthog` credential — outbound capture is live without POSTHOG_API_KEY.',
        );
      })
      .catch(() => {});
  }

  return client;
}
