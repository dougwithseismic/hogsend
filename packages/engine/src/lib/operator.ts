import { type Database, user } from "@hogsend/db";
import { normalizeEmail, normalizeEmailOrNull } from "./contacts.js";

/**
 * True iff `email` is a member of the operator set: a row in the `user` table,
 * or the env-configured operator inbox (`HOGSEND_TEST_EMAIL` /
 * `STUDIO_ADMIN_EMAIL`). Comparison is case-insensitive (`normalizeEmail`).
 *
 * The `user` table IS the operator set: admins are minted only by the CLI or the
 * boot bootstrap (there is no unauthenticated path to create one), so a
 * closed-signup deploy has a handful of rows. The two env addresses are the same
 * operator inboxes test-mode redirects to.
 */
export async function isOperatorAddress(opts: {
  db: Database;
  env: { HOGSEND_TEST_EMAIL?: string; STUDIO_ADMIN_EMAIL?: string };
  email: string;
}): Promise<boolean> {
  const target = normalizeEmail(opts.email);
  if (!target) return false;

  // Match how addresses are stored/compared everywhere else (contacts.ts) so
  // this security gate can't silently diverge from the canonical normalization.
  if (normalizeEmailOrNull(opts.env.HOGSEND_TEST_EMAIL) === target) return true;
  if (normalizeEmailOrNull(opts.env.STUDIO_ADMIN_EMAIL) === target) return true;

  // The admin team is a handful of rows (closed signup), so a full scan +
  // normalized compare is cheaper and simpler than a lower() predicate.
  const rows = await opts.db.select({ email: user.email }).from(user);
  return rows.some((r) => normalizeEmail(r.email) === target);
}
