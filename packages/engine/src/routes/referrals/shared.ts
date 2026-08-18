import { DEFAULT_REFERRAL_ID } from "@hogsend/core";
import type { Database } from "@hogsend/db";
import { z } from "@hono/zod-openapi";
import { resolveContact } from "../../lib/contacts.js";

/**
 * Helpers shared by the `/v1/referrals` routes. Nothing here creates a
 * contact: an operator naming a key is asking a QUESTION, and minting a row to
 * answer it is the ghost-contact case PRD 02 forbade.
 */

/** Every route takes the same optional `referral` selector. */
export const referralIdQuery = z
  .string()
  .min(1)
  .optional()
  .describe(`The defineReferral id. Default "${DEFAULT_REFERRAL_ID}".`);

export function resolveReferralId(input: string | undefined): string {
  return input ?? DEFAULT_REFERRAL_ID;
}

/**
 * Resolve a contact an operator named by uuid or external key. `null` = no
 * such contact; the caller decides whether that is a 404 or a skipped row.
 */
export async function resolveNamedContactId(
  db: Database,
  key: string | undefined,
): Promise<string | null> {
  if (!key) return null;
  const row = await resolveContact({ db, id: key });
  return row?.id ?? null;
}
