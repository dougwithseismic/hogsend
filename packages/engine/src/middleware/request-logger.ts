import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../app.js";

export const requestLogger: MiddlewareHandler<AppEnv> = async (c, next) => {
  const start = Date.now();

  await next();

  const duration = Date.now() - start;
  const logger = c.get("container").logger;

  logger.http("request", {
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    duration,
    requestId: c.get("requestId"),
  });
};
