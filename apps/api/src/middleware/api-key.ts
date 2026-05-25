import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../app.js";

export const requireApiKey = createMiddleware<AppEnv>(async (c, next) => {
  const { env } = c.get("container");

  if (!env.ADMIN_API_KEY) {
    return c.json({ error: "Admin API not configured" }, 503);
  }

  const header = c.req.header("authorization");
  const provided = header?.startsWith("Bearer ") ? header.slice(7) : undefined;

  if (!provided || provided !== env.ADMIN_API_KEY) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  return next();
});
