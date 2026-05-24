import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../app.js";

async function resolveSession(c: Context<AppEnv>) {
  const { auth } = c.get("container");
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  c.set("user", session?.user ?? null);
  c.set("session", session?.session ?? null);
  return session;
}

export const sessionMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  await resolveSession(c);
  return next();
});

export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const session = await resolveSession(c);
  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  return next();
});
