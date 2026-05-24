import {
  createDatabase,
  type Database,
  type DatabaseClient,
} from "@growthhog/db";
import { env } from "./env.js";
import { type Auth, createAuth } from "./lib/auth.js";
import { createLogger, type Logger } from "./lib/logger.js";

export interface Container {
  env: typeof env;
  logger: Logger;
  db: Database;
  dbClient: DatabaseClient;
  auth: Auth;
}

export function createContainer(): Container {
  const logger = createLogger(env.LOG_LEVEL);
  const { db, client } = createDatabase(env.DATABASE_URL);
  const auth = createAuth(db, {
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
  });

  return {
    env,
    logger,
    db,
    dbClient: client,
    auth,
  };
}
