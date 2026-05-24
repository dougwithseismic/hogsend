import type { ErrorHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "../app.js";

export const errorHandler: ErrorHandler<AppEnv> = (err, c) => {
  const logger = c.get("container").logger;

  const status: ContentfulStatusCode =
    "status" in err && typeof err.status === "number"
      ? (err.status as ContentfulStatusCode)
      : 500;
  const message = status === 500 ? "Internal Server Error" : err.message;

  logger.error(err.message, {
    stack: err.stack,
    path: c.req.path,
    method: c.req.method,
    status,
  });

  return c.json({ error: message }, status);
};
