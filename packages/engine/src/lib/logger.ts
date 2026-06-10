import winston from "winston";

// Log to stdout only (12-factor): the platform — Railway, Docker, a VPS's
// systemd/journald — captures the stream. Writing log FILES from inside the app
// breaks in a non-root container (mkdir EACCES on a root-owned /app) and is
// pointless on ephemeral container filesystems. If durable file logs are ever
// needed, add a File transport behind an explicit, writable LOG_DIR opt-in.
export function createLogger(level: string = "info") {
  return winston.createLogger({
    level,
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
    ),
    // Service label for structured logs. Override per-deploy with SERVICE_NAME;
    // the neutral default keeps scaffolded apps from inheriting dogfood branding.
    defaultMeta: { service: process.env.SERVICE_NAME ?? "hogsend" },
    transports: [
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.printf(({ level, message, timestamp, ...meta }) => {
            const metaStr = Object.keys(meta).length
              ? ` ${JSON.stringify(meta)}`
              : "";
            return `${timestamp} ${level}: ${message}${metaStr}`;
          }),
        ),
      }),
    ],
  });
}

export type Logger = winston.Logger;
