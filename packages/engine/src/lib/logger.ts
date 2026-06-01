import path from "node:path";
import winston from "winston";

const LOG_DIR = path.resolve(process.cwd(), "logs");

export function createLogger(level: string = "info") {
  return winston.createLogger({
    level,
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
    ),
    defaultMeta: { service: "growthhog-api" },
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
      new winston.transports.File({
        filename: path.join(LOG_DIR, "error.log"),
        level: "error",
        format: winston.format.json(),
        maxsize: 10_000_000,
        maxFiles: 5,
      }),
      new winston.transports.File({
        filename: path.join(LOG_DIR, "combined.log"),
        format: winston.format.json(),
        maxsize: 10_000_000,
        maxFiles: 5,
      }),
    ],
  });
}

export type Logger = winston.Logger;
