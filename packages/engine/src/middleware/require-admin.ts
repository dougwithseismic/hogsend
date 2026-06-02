import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../app.js";
import { requireApiKey } from "./api-key.js";

// Authorizes admin routes via EITHER an API key (Bearer header, the
// programmatic/CLI path) OR a Better-Auth session (cookie, the Studio path).
// A Bearer header is always treated as an API key; otherwise we resolve the
// session. Role-based gating is deferred — the security control for the session
// path is closed signup (only the first user can register; see app.ts), so any
// authenticated session is an intended admin in this single-tenant model.
export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header("authorization");
  if (header?.startsWith("Bearer ")) {
    return requireApiKey(c, next);
  }

  const { auth } = c.get("container");
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session?.user) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  c.set("user", session.user);
  c.set("session", session.session);
  return next();
});
