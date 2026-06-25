import type { Context } from "hono";
import { InvalidUserTokenError, verifyUserToken } from "../lib/user-token.js";

/**
 * The data-plane identity guard shared by `/v1/contacts`, `/v1/events`,
 * `/v1/emails`, and `/v1/lists`: a request must carry at least one resolvable
 * identity key. Returns the 400 JSON response when BOTH keys are absent (so the
 * caller can `return guard;`), or `null` to proceed.
 *
 * `/v1/emails` names its recipient field `to` rather than `email`; pass
 * `{ field: "to" }` so the 400 message matches that route's wording exactly.
 */
export function requireIdentity(
  c: Context,
  identity: { email?: string; userId?: string },
  opts?: { field?: "email" | "to" },
) {
  if (!identity.email && !identity.userId) {
    const field = opts?.field ?? "email";
    return c.json({ error: `${field} or userId is required` }, 400);
  }
  return null;
}

/**
 * The publishable-key identity gate, shared by every browser-reachable handler
 * (events ingest, contacts upsert, list subscribe/unsubscribe).
 *
 *   - SECRET key (`!c.get("publishable")`): defers to the UNCHANGED
 *     `requireIdentity` — identical 400 wording, identical behavior.
 *
 *   - PUBLISHABLE key: a token-less pk_ key may act ONLY on its own anon id.
 *     - No claimed identity (`email`/`userId` both absent) → allowed (the
 *       secure anon-only default). Returns `null`.
 *     - A claimed identity REQUIRES a verified `userToken` proving the
 *       `userId`. Reject with 403 when: no `userToken`; `email` is asserted
 *       (no email arm exists in v1 — a token only binds a userId); or the
 *       token's `userId` does not match the claimed `userId`.
 *
 * Returns a `Response` to `return`, or `null` to proceed.
 */
export function gatePublishableIdentity(
  c: Context,
  body: { email?: string; userId?: string; userToken?: string },
  secret: string,
  opts?: { field?: "email" | "to" },
) {
  if (!c.get("publishable")) {
    return requireIdentity(c, body, opts);
  }

  // Publishable. No claimed identity → anon-only, allowed (the secure default).
  if (!body.email && !body.userId) return null;

  // Claimed identity REQUIRES a verified userToken binding the userId.
  if (!body.userToken) {
    return c.json(
      {
        error:
          "publishable key cannot act on another identity without a userToken",
      },
      403,
    );
  }

  try {
    const payload = verifyUserToken({ token: body.userToken, secret });
    // A token binds ONLY a userId (v1 has no email arm). Reject any asserted
    // email, and require the claimed userId to match the token's userId.
    if (body.email || (body.userId && body.userId !== payload.userId)) {
      return c.json(
        { error: "userToken does not authorize this identity" },
        403,
      );
    }
    return null;
  } catch (err) {
    if (err instanceof InvalidUserTokenError) {
      return c.json({ error: "Invalid userToken" }, 403);
    }
    throw err;
  }
}

/**
 * Extract a human-readable message from an `applyListMembership` failure,
 * matching the wording every data-plane route used inline.
 */
export function listMembershipError(err: unknown): string {
  return err instanceof Error ? err.message : "Failed to apply list membership";
}
