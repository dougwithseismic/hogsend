import type { HatchetClient } from "@hatchet-dev/typescript-sdk/v1/index.js";
import type { EmailProvider, PostHogService, TimeZone } from "@hogsend/core";
import type { BucketRegistry, JourneyRegistry } from "@hogsend/core/registry";
import type { SendWindow } from "@hogsend/core/schedule";
import {
  createDatabase,
  type Database,
  type DatabaseClient,
  type JournalShape,
} from "@hogsend/db";
import type { TemplateRegistry } from "@hogsend/email";
import { createBucketAccessor } from "./buckets/bucket-access.js";
import type { DefinedBucket } from "./buckets/define-bucket.js";
import {
  buildBucketRegistry,
  collectBucketReactionJourneys,
} from "./buckets/registry.js";
import type { DefinedDestination } from "./destinations/define-destination.js";
import { destinationsFromEnv } from "./destinations/presets/index.js";
import {
  DestinationRegistry,
  setDestinationRegistry,
} from "./destinations/registry-singleton.js";
import { env } from "./env.js";
import { setClientScheduleDefaults } from "./journeys/client-defaults-singleton.js";
import type { DefinedJourney } from "./journeys/define-journey.js";
import { buildJourneyRegistry } from "./journeys/registry.js";
import { setAnalytics } from "./lib/analytics-singleton.js";
import { type Auth, createAuth } from "./lib/auth.js";
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
import { hatchet } from "./lib/hatchet.js";
import { createLogger, type Logger } from "./lib/logger.js";
import { createTrackedMailer } from "./lib/mailer.js";
import { getPostHog } from "./lib/posthog.js";
import { createRedisSecondaryStorage, getRedis } from "./lib/redis.js";
import { sendResetPasswordEmail } from "./lib/reset-email.js";
import { seedPostHogDestination } from "./lib/seed-posthog-destination.js";
import { prepareTrackedHtml } from "./lib/tracking.js";
import type { DefinedList } from "./lists/define-list.js";
import { buildListRegistry, type ListRegistry } from "./lists/registry.js";

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
  analytics?: PostHogService;
  registry: JourneyRegistry;
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
   * The PostHog-style analytics service. As of the destinations spine its role
   * is deliberately NARROW — it is NOT the outbound-catalog firing path (the
   * email/contact/journey/bucket lifecycle now fans out durably via
   * DESTINATIONS on the webhook spine, keyed by `webhook_endpoints.kind`). It
   * remains for exactly two things:
   *
   * 1. The identity PULL — `getPersonProperties` for per-user timezone
   *    resolution at journey enrollment (`define-journey` / `lib/timezone.ts`).
   *    This read role is UNCHANGED and load-bearing.
   * 2. The opt-in `bucket.syncToPostHog` person-property mirror — `$set`/`$unset`
   *    of a boolean cohort property on bucket transitions (`bucket-posthog-sync`).
   *    Off by default; PostHog `$set`/`$unset` identity semantics have no
   *    vendor-neutral envelope, so this stays a PostHog-direct write.
   *
   * Lives at the top level (not under `email`) because the engine itself uses
   * it for the PULL. Defaults to {@link getPostHog} (a no-op when
   * `POSTHOG_API_KEY` is unset).
   */
  analytics?: PostHogService;
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

export function createHogsendClient(
  opts: HogsendClientOptions = {},
): HogsendClient {
  const logger = createLogger(env.LOG_LEVEL);
  const created = createDatabase({ url: env.DATABASE_URL });
  const db = opts.overrides?.db ?? created.db;

  const registry = buildJourneyRegistry(
    opts.journeys ?? [],
    opts.enabledJourneys ?? env.ENABLED_JOURNEYS,
  );

  // Installs the bucket registry singleton in BOTH the API and worker processes
  // (both call createHogsendClient); the real-time ingest path reads it via
  // getBucketRegistrySingleton().
  const buckets = opts.buckets ?? [];
  const enabledBuckets = opts.enabledBuckets ?? env.ENABLED_BUCKETS;
  const bucketRegistry = buildBucketRegistry(buckets, enabledBuckets);

  // Register the reaction journeys generated by `bucket.on()` into the journey
  // registry AFTER buildJourneyRegistry, bypassing the ENABLED_JOURNEYS filter:
  // reactions are bucket-owned and were already gated by ENABLED_BUCKETS
  // (collectBucketReactionJourneys), so their `bucket-<id>-on-<kind>` ids must NOT
  // be subject to the journeys csv (Section 9). Both API and worker call
  // createHogsendClient, so the singleton carries reaction metas in both
  // processes (needed for admin feedsJourneys + the dwell-cron lookup).
  for (const reaction of collectBucketReactionJourneys(
    buckets,
    enabledBuckets,
  )) {
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
  const listRegistry = buildListRegistry(
    opts.lists ?? [],
    opts.enabledLists ?? env.ENABLED_LISTS,
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
  const activeId =
    opts.email?.defaultProvider ?? env.EMAIL_PROVIDER ?? "resend";
  const provider = emailProviders.get(activeId);

  if (!provider) {
    throw new Error(
      `email provider "${activeId}" is not registered (registered: ${emailProviders
        .getAll()
        .map((p) => p.meta?.id ?? "resend")
        .join(", ")})`,
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
      } reports account-level native tracking ON; disable it in the dashboard — first-party tracking is Hogsend's source of truth.`,
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
      },
    );

  setEmailService(emailService);

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

  const analytics = opts.analytics ?? getPostHog();

  // Expose the resolved analytics instance to the module-level task-execution
  // sites that have no client reference. Its role is NARROW (see the
  // `analytics?` option doc): the identity PULL (`getPersonProperties` for tz
  // resolution in the journey durable task) plus the opt-in
  // `bucket.syncToPostHog` person-property mirror — NOT the outbound catalog
  // firing path (that is the destinations spine). `createHogsendClient` runs in
  // both the API and worker, so this is installed before any worker task runs.
  // May be undefined (no POSTHOG_API_KEY) — the reads stay no-ops.
  setAnalytics(analytics);

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

  return {
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
    analytics,
    registry,
    bucketRegistry,
    listRegistry,
    hatchet: opts.overrides?.hatchet ?? hatchet,
    clientJournal: opts.clientJournal ?? { entries: [] },
    defaults,
  };
}
