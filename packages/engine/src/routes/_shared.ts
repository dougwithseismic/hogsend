import type { Context } from "hono";

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
 * Extract a human-readable message from an `applyListMembership` failure,
 * matching the wording every data-plane route used inline.
 */
export function listMembershipError(err: unknown): string {
  return err instanceof Error ? err.message : "Failed to apply list membership";
}
