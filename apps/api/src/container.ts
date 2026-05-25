import type { HatchetClient } from "@hatchet-dev/typescript-sdk/v1/index.js";
import type { JourneyRegistry } from "@hogsend/core/registry";
import {
  createDatabase,
  type Database,
  type DatabaseClient,
} from "@hogsend/db";
import {
  createEmailService,
  createResendClient,
  type EmailService,
} from "@hogsend/plugin-resend";
import type { Resend } from "resend";
import { env } from "./env.js";
import { createJourneyRegistry } from "./journeys/index.js";
import { type Auth, createAuth } from "./lib/auth.js";
import { hatchet } from "./lib/hatchet.js";
import { createLogger, type Logger } from "./lib/logger.js";

export interface Container {
  env: typeof env;
  logger: Logger;
  db: Database;
  dbClient: DatabaseClient;
  auth: Auth;
  email: Resend;
  emailService: EmailService | null;
  registry: JourneyRegistry;
  hatchet: HatchetClient;
}

export function createContainer(): Container {
  const logger = createLogger(env.LOG_LEVEL);
  const { db, client } = createDatabase({ url: env.DATABASE_URL });
  const auth = createAuth(db, {
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
  });
  const email = createResendClient({ apiKey: env.RESEND_API_KEY });
  const registry = createJourneyRegistry(env.ENABLED_JOURNEYS);

  const emailService = env.RESEND_WEBHOOK_SECRET
    ? createEmailService({
        apiKey: env.RESEND_API_KEY,
        defaultFrom: env.RESEND_FROM_EMAIL,
        db,
        webhookSecret: env.RESEND_WEBHOOK_SECRET,
        bounceThreshold: 3,
      })
    : null;

  logger.info(`Journey registry loaded: ${registry.count()} journeys`);

  return {
    env,
    logger,
    db,
    dbClient: client,
    auth,
    email,
    emailService,
    registry,
    hatchet,
  };
}
