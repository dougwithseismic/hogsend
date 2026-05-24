import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../app.js";

export const sessionMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const { auth } = c.get("container");
  const session = await auth.api.getSession({ headers: c.req.raw.headers });

  if (!session) {
    c.set("user", null);
    c.set("session", null);
    return next();
  }

  c.set("user", session.user);
  c.set("session", session.session);
  return next();
});

export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const { auth } = c.get("container");
  const session = await auth.api.getSession({ headers: c.req.raw.headers });

  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  c.set("user", session.user);
  c.set("session", session.session);
  return next();
});
