import { contacts, type Database } from "@hogsend/db";
import { and, eq, isNull } from "drizzle-orm";
import { normalizeEmail, resolveContact } from "../../lib/contacts.js";

/**
 * Resolve the contact an OPERATOR named, by id or by email. Secret keys are
 * server-trusted, so both keys are honoured directly — the same posture as
 * `resolveFeedRecipient`'s secret arm (`routes/feed/recipient.ts:104-111`).
 *
 * It NEVER creates. A `/v1/accounts` route naming an unknown contact is a
 * question, not an identity assertion, so minting one here would be exactly
 * the ghost-contact case `resolveContactNoCreate` exists to prevent (and the
 * import path reports it as a conflict rather than inventing an owner).
 *
 * `contactId` goes through `resolveContact`, so a uuid, an `external_id` and a
 * merged-away external alias all resolve to the live survivor.
 */
export async function resolveAccountsContactId(
  db: Database,
  key: { contactId?: string; email?: string },
): Promise<string | null> {
  if (key.contactId) {
    const row = await resolveContact({ db, id: key.contactId });
    return row?.id ?? null;
  }
  if (key.email) {
    const [row] = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(
        and(
          eq(contacts.email, normalizeEmail(key.email)),
          isNull(contacts.deletedAt),
        ),
      )
      .limit(1);
    return row?.id ?? null;
  }
  return null;
}

/**
 * Resolve the contact a VERIFIED `userToken` names, and nothing else.
 *
 * The token's `userId` is the ONLY input — never a `contactId`, an `email` or a
 * `userId` from the request body (DECISIONS §6.3/§6.5). `resolveContact`
 * matches a uuid or an `external_id` (including a merged-away alias), which is
 * the same key `contactKey()` hands back on the outbound plane, so the SDK's
 * "the userId I minted a token for" and the engine's answer are one value.
 *
 * Returns `null` for "no such contact". Every caller turns that into its
 * ordinary EMPTY answer, never a 404 — a player-facing route must not confirm
 * whether a person exists.
 */
export async function resolveTokenContactId(
  db: Database,
  userId: string,
): Promise<string | null> {
  const row = await resolveContact({ db, id: userId });
  return row?.id ?? null;
}
