import type { HatchetClient } from "@hatchet-dev/typescript-sdk/v1/index.js";
import type { TimeZone } from "@hogsend/core";
import type { BucketRegistry, JourneyRegistry } from "@hogsend/core/registry";
import type { SendWindow } from "@hogsend/core/schedule";
import {
  createDatabase,
  type Database,
  type DatabaseClient,
  type JournalShape,
} from "@hogsend/db";
import type { TemplateRegistry } from "@hogsend/email";
import type { PostHogService } from "@hogsend/plugin-posthog";
import {
  createResendClient,
  createResendProvider,
  type EmailProvider,
} from "@hogsend/plugin-resend";
import type { Resend } from "resend";
import type { DefinedBucket } from "./buckets/define-bucket.js";
import { buildBucketRegistry } from "./buckets/registry.js";
import { env } from "./env.js";
import { setClientScheduleDefaults } from "./journeys/client-defaults-singleton.js";
import type { DefinedJourney } from "./journeys/define-journey.js";
import { buildJourneyRegistry } from "./journeys/registry.js";
import { type Auth, createAuth } from "./lib/auth.js";
import { setEmailService } from "./lib/email.js";
import type {
  EmailService,
  FrequencyCapConfig,
} from "./lib/email-service-types.js";
import { hatchet } from "./lib/hatchet.js";
import { createLogger, type Logger } from "./lib/logger.js";
import { createTrackedMailer } from "./lib/mailer.js";
import { getPostHog } from "./lib/posthog.js";
import { prepareTrackedHtml } from "./lib/tracking.js";

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
  email: Resend;
  emailService: EmailService;
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
   * Email is a first-class channel. Its config is grouped here rather than
   * spread across top-level args — the engine owns the cohesive email pipeline
   * (templates → render → preference checks → tracking → `email_sends` write),
   * and the {@link EmailProvider} is only the swappable wire under it.
   *
   * - `provider` — the swappable email provider (Resend, Postmark, SES…).
   *   Defaults to a Resend provider built from env (`RESEND_API_KEY` /
   *   `RESEND_WEBHOOK_SECRET`). Tracking/rendering/preferences come along for
   *   free regardless of which provider you supply.
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
    templates?: TemplateRegistry;
  };
  /**
   * The PostHog-style analytics service used for person properties + event
   * capture. Lives at the top level (not under `email`) because the engine
   * itself uses it — tracking routes and ingestion fire captures. Defaults to
   * {@link getPostHog} (a no-op when `POSTHOG_API_KEY` is unset).
   */
  analytics?: PostHogService;
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

  const auth =
    opts.overrides?.auth ??
    createAuth({
      db,
      secret: env.BETTER_AUTH_SECRET,
      baseURL: env.BETTER_AUTH_URL,
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
    });

  const email = createResendClient({ apiKey: env.RESEND_API_KEY });

  const registry = buildJourneyRegistry(
    opts.journeys ?? [],
    opts.enabledJourneys ?? env.ENABLED_JOURNEYS,
  );

  // Installs the bucket registry singleton in BOTH the API and worker processes
  // (both call createHogsendClient); the real-time ingest path reads it via
  // getBucketRegistrySingleton().
  const bucketRegistry = buildBucketRegistry(
    opts.buckets ?? [],
    opts.enabledBuckets ?? env.ENABLED_BUCKETS,
  );

  const provider =
    opts.email?.provider ??
    createResendProvider({
      apiKey: env.RESEND_API_KEY,
      webhookSecret: env.RESEND_WEBHOOK_SECRET,
    });

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
        defaultFrom: env.RESEND_FROM_EMAIL,
        templates,
        db,
        webhookSecret: env.RESEND_WEBHOOK_SECRET,
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

  const analytics = opts.analytics ?? getPostHog();

  logger.info(`Journey registry loaded: ${registry.count()} journeys`);
  logger.info(`Bucket registry loaded: ${bucketRegistry.count()} buckets`);

  return {
    env,
    logger,
    db,
    dbClient: created.client,
    auth,
    email,
    emailService,
    templates,
    analytics,
    registry,
    bucketRegistry,
    hatchet: opts.overrides?.hatchet ?? hatchet,
    clientJournal: opts.clientJournal ?? { entries: [] },
    defaults,
  };
}
