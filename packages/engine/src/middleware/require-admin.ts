import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../app.js";
import { hasScope, requireApiKey } from "./api-key.js";

// Authorizes admin routes via EITHER an API key (Bearer header, the
// programmatic/CLI path) OR a Better-Auth session (cookie, the Studio path).
// A Bearer header is always treated as an API key; otherwise we resolve the
// session. Role-based gating is deferred — the security control for the session
// path is closed signup (only the first user can register; see app.ts), so any
// authenticated session is an intended admin in this single-tenant model.
export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header("authorization");
  if (header?.startsWith("Bearer ")) {
    // Authenticate the key, then REQUIRE `full-admin` scope. Without this,
    // ANY valid non-revoked key reaches the entire admin surface — including a
    // PUBLISHABLE (pk_/ingest-public) key embedded in browser JS, which could
    // then mint a full-admin secret. `requireApiKey` only runs its `next` on a
    // successful auth (else it returns 401/expired), so use a flag to surface
    // its short-circuit response; otherwise apply the scope gate.
    let authed = false;
    const res = await requireApiKey(c, async () => {
      authed = true;
    });
    if (!authed) return res;

    const apiKey = c.get("apiKey");
    if (!apiKey || !hasScope(apiKey.scopes, "full-admin")) {
      return c.json({ error: "Forbidden: insufficient scope" }, 403);
    }
    return next();
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
