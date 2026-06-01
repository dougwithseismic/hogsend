import type { HatchetClient } from "@hatchet-dev/typescript-sdk/v1/index.js";
import type { JourneyRegistry } from "@hogsend/core/registry";
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
import { env } from "./env.js";
import type { DefinedJourney } from "./journeys/define-journey.js";
import { buildJourneyRegistry } from "./journeys/registry.js";
import { type Auth, createAuth } from "./lib/auth.js";
import { setEmailService } from "./lib/email.js";
import type { EmailService } from "./lib/email-service-types.js";
import { hatchet } from "./lib/hatchet.js";
import { createLogger, type Logger } from "./lib/logger.js";
import { createTrackedMailer } from "./lib/mailer.js";
import { getPostHog } from "./lib/posthog.js";
import { prepareTrackedHtml } from "./lib/tracking.js";

export interface HogsendClient {
  env: typeof env;
  logger: Logger;
  db: Database;
  dbClient: DatabaseClient;
  auth: Auth;
  email: Resend;
  emailService: EmailService;
  analytics?: PostHogService;
  registry: JourneyRegistry;
  hatchet: HatchetClient;
  /**
   * The client repo's migration journal (`migrations/meta/_journal.json`),
   * powering the `schema.client` block of `GET /v1/health`. Defaults to an
   * empty journal — a client that injects none has a trivially-in-sync client
   * track. The CLIENT track never gates boot (client-owned); engine does.
   */
  clientJournal: JournalShape;
}

export interface HogsendClientOptions {
  /** Journeys to register in the {@link JourneyRegistry}. Defaults to none. */
  journeys?: DefinedJourney[];
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
   * The client repo's migration journal for the `schema.client` health block.
   * Defaults to `{ entries: [] }` (empty client track ⇒ trivially in sync).
   */
  clientJournal?: JournalShape;
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
    });

  const email = createResendClient({ apiKey: env.RESEND_API_KEY });

  const registry = buildJourneyRegistry(
    opts.journeys ?? [],
    opts.enabledJourneys ?? env.ENABLED_JOURNEYS,
  );

  const provider =
    opts.email?.provider ??
    createResendProvider({
      apiKey: env.RESEND_API_KEY,
      webhookSecret: env.RESEND_WEBHOOK_SECRET,
    });

  const emailService =
    opts.overrides?.mailer ??
    createTrackedMailer(
      {
        defaultFrom: env.RESEND_FROM_EMAIL,
        templates: opts.email?.templates ?? ({} as TemplateRegistry),
        db,
        webhookSecret: env.RESEND_WEBHOOK_SECRET,
        bounceThreshold: 3,
        baseUrl: env.API_PUBLIC_URL,
      },
      {
        provider,
        prepareTrackedHtml,
      },
    );

  setEmailService(emailService);

  const analytics = opts.analytics ?? getPostHog();

  logger.info(`Journey registry loaded: ${registry.count()} journeys`);

  return {
    env,
    logger,
    db,
    dbClient: created.client,
    auth,
    email,
    emailService,
    analytics,
    registry,
    hatchet: opts.overrides?.hatchet ?? hatchet,
    clientJournal: opts.clientJournal ?? { entries: [] },
  };
}
