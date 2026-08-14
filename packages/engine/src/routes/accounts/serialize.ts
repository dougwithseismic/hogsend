import { z } from "@hono/zod-openapi";
import type { LinkedAccountRecord } from "../../lib/account-links.js";

/**
 * TWO SHAPES, ONE ROW (PRD 09 T2). The `linked_accounts` row leaves the engine
 * through exactly one of these, and which one is decided by the AUTH TIER of
 * the route, never by a query parameter.
 *
 * Both mirror `serializeGroup` (`routes/groups/index.ts:31-43`): a fresh object
 * literal, timestamps as ISO strings, internal columns dropped.
 */

/**
 * The OPERATOR shape — secret-key routes only (`GET /v1/accounts`, the reverse
 * lookup, the import conflicts). Carries the reconciliation facts a customer's
 * own store needs: the owning `contactId`, the monotonic `version`, and
 * `tokensRevokedAt` (DECISIONS §10).
 *
 * The sealed `tokens` blob is NOT here and cannot be: `LinkedAccountRecord`
 * already collapsed it to `hasTokens` inside the store, which is the one place
 * the column is ever selected.
 */
export const linkedAccountSchema = z.object({
  provider: z.string(),
  providerUserId: z.string(),
  contactId: z.string(),
  username: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  method: z.enum(["oauth", "import"]),
  /**
   * A Postgres `bigint` as a decimal STRING (DECISIONS §5.1), never a JSON
   * number. The customer's whole contract is an exact
   * `incoming.version > stored.version` comparison, and a version above
   * `Number.MAX_SAFE_INTEGER` rounded through float64 breaks that guard
   * INVISIBLY — the wrong owner is recorded and nothing errors.
   */
  version: z.string(),
  linkedAt: z.string(),
  tokensRevokedAt: z.string().nullable(),
});

export type SerializedLinkedAccount = z.infer<typeof linkedAccountSchema>;

/**
 * The ONLY shape `GET /v1/accounts/me` may return (DECISIONS §6.9). Four
 * display keys. It structurally cannot carry an id, a version or an email, so
 * a browser response can neither confirm which platform account a person holds
 * nor be replayed into the operator plane.
 */
export const publicLinkedAccountSchema = z.object({
  provider: z.string(),
  username: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  linkedAt: z.string(),
});

export type SerializedPublicLinkedAccount = z.infer<
  typeof publicLinkedAccountSchema
>;

export function serializeLinkedAccount(
  row: LinkedAccountRecord,
): SerializedLinkedAccount {
  return {
    provider: row.provider,
    providerUserId: row.providerUserId,
    contactId: row.contactId,
    username: row.username,
    avatarUrl: row.avatarUrl,
    method: row.method,
    // ALREADY a string off the store (`String(row.version)`), forwarded
    // verbatim. Nothing on this plane parses it.
    version: row.version,
    linkedAt: row.linkedAt.toISOString(),
    tokensRevokedAt: row.tokensRevokedAt
      ? row.tokensRevokedAt.toISOString()
      : null,
  };
}

/**
 * Builds a FRESH OBJECT LITERAL with four keys. It never spreads the row and
 * must never start to: a spread is how `providerUserId` leaks the day someone
 * adds a column, and the test that pins this asserts the KEY SET rather than a
 * sample row, so the leak fails a test instead of shipping.
 */
export function serializePublicLinkedAccount(
  row: LinkedAccountRecord,
): SerializedPublicLinkedAccount {
  return {
    provider: row.provider,
    username: row.username,
    avatarUrl: row.avatarUrl,
    linkedAt: row.linkedAt.toISOString(),
  };
}
