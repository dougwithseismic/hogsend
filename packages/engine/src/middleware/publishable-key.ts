import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../app.js";
import { hashApiKey } from "../lib/api-key-hash.js";
import { hasScope, loadApiKey, requireApiKey } from "./api-key.js";

/**
 * Data-plane guard for the BROWSER-REACHABLE subset of `/v1` (POST /events, the
 * contacts upsert, GET /lists, list subscribe/unsubscribe, GET /lists/preferences).
 *
 * Accepts EITHER credential class:
 *
 *   - SECRET key (anything NOT prefixed `pk_`): delegates to the UNCHANGED
 *     `requireApiKey` (legacy ADMIN_API_KEY + 60s cache + expiry), then applies
 *     the same `requireScope("ingest")` check inline. This path is
 *     byte-for-byte behaviorally identical to the existing
 *     `requireApiKey` → `requireScope("ingest")` stack.
 *
 *   - PUBLISHABLE key (`pk_` bearer): read through the same 60s key cache
 *     (`loadApiKey`, which carries `allowed_origins`) with the same debounced
 *     `lastUsedAt` bump as secret keys. Requires scope `ingest-public`
 *     and REJECTS any pk_ token that somehow also carries `ingest`/`full-admin`
 *     (defence in depth — a prefix never implies privilege). Enforces the
 *     per-key Origin allowlist FAIL-CLOSED (no/empty allowlist ⇒ reject; Origin
 *     not in the allowlist ⇒ reject), then sets `publishable = true`.
 *
 * A pk_ key therefore cannot reach any route this guard is not mounted on, and
 * cannot pass `requireScope("ingest")` anywhere else (its `["ingest-public"]`
 * scope is neither `ingest` nor `full-admin`).
 */
export const requirePublishableOrIngest = createMiddleware<AppEnv>(
  async (c, next) => {
    const header = c.req.header("authorization");
    const provided = header?.startsWith("Bearer ")
      ? header.slice(7)
      : undefined;

    if (!provided) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    // SECRET path: NOT a pk_ token → behave EXACTLY like the existing data-plane
    // guard. Delegate to the unchanged `requireApiKey` (so the legacy
    // ADMIN_API_KEY + cache + expiry logic stays in ONE place), then apply the
    // same `requireScope("ingest")` check inline. `requireApiKey` only calls its
    // `next` on a successful auth — if it 401s it never runs the inner check, so
    // `authed` stays false and we return whatever response it produced.
    if (!provided.startsWith("pk_")) {
      let authed = false;
      const res = await requireApiKey(c, async () => {
        authed = true;
      });
      if (!authed) {
        // requireApiKey short-circuited (401/expired) — return its response.
        return res;
      }
      const apiKey = c.get("apiKey");
      if (!apiKey || !hasScope(apiKey.scopes, "ingest")) {
        return c.json({ error: "Forbidden: insufficient scope" }, 403);
      }
      return next();
    }

    // PUBLISHABLE path: pk_ token. Same cached read as the secret path (a
    // browser key is hit on every page view, so an uncached lookup plus an
    // undebounced `lastUsedAt` write was two statements per request). Revoking
    // or rotating evicts it here at once; other instances pick it up within
    // the 60s TTL, the same lag secret keys have.
    const { db } = c.get("container");
    const key = await loadApiKey(db, hashApiKey(provided));
    if (!key) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    if (key.expiresAt && key.expiresAt < new Date()) {
      return c.json({ error: "API key expired" }, 401);
    }

    const scopes = key.scopes;
    // A pk_ key MUST be exactly a publishable key. Reject a pk_-prefixed token
    // that somehow carries `ingest`/`full-admin` — the mint route forces
    // `["ingest-public"]`, but never trust the prefix alone to imply privilege.
    if (
      !scopes.includes("ingest-public") ||
      scopes.includes("ingest") ||
      scopes.includes("full-admin")
    ) {
      return c.json({ error: "Forbidden: insufficient scope" }, 403);
    }

    // Per-key Origin allowlist — FAIL-CLOSED. No allowlist (null/empty), no
    // Origin header, or an Origin not in the allowlist ⇒ reject.
    const allowed = key.allowedOrigins ?? [];
    const origin = c.req.header("origin");
    if (allowed.length === 0 || !origin || !allowed.includes(origin)) {
      return c.json({ error: "Forbidden: origin not allowed" }, 403);
    }

    c.set("apiKey", {
      id: key.id,
      name: key.name,
      scopes,
      allowedOrigins: allowed,
    });
    c.set("publishable", true);

    return next();
  },
);
