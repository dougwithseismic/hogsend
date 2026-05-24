import { env } from "./env.js";
import { createLogger, type Logger } from "./lib/logger.js";

export interface Container {
  env: typeof env;
  logger: Logger;
}

export function createContainer(): Container {
  const logger = createLogger(env.LOG_LEVEL);

  return {
    env,
    logger,
  };
}
