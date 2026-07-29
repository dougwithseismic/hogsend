/**
 * PRD 05 T3 — the shared "was this a unique_violation on THAT index?" probe.
 *
 * The contact-scoped uniqueness indexes are pure CONSTRAINTS: no upsert names
 * them as an `ON CONFLICT` arbiter, because drizzle can only target columns and
 * a bare `(contact_id, …)` arbiter would never fire for the NULL (contactless)
 * population — an anonymous re-trigger would then insert a second row and die on
 * the retained string index. So each writer keeps its string arbiter and
 * converts THIS error into its own already-exists branch.
 *
 * Postgres reports the code as 23505 and names the index in `constraint_name`,
 * but drizzle wraps the driver error in a `DrizzleQueryError`, so the real
 * payload lives on `cause` (sometimes nested) — walk the chain, bounded. Mirrors
 * `isSlugUniqueViolation` (lib/links.ts) and `isPhoneUniqueViolation`
 * (lib/contacts.ts); this is the extracted, shared form.
 */
export function isUniqueViolationOn(err: unknown, index: string): boolean {
  for (let e = err, depth = 0; e && depth < 5; depth++) {
    const candidate = e as {
      code?: string;
      constraint_name?: string;
      constraint?: string;
      message?: string;
      cause?: unknown;
    };
    if (
      candidate.code === "23505" &&
      (candidate.constraint_name === index ||
        candidate.constraint === index ||
        (candidate.message?.includes(index) ?? false))
    ) {
      return true;
    }
    e = candidate.cause;
  }
  return false;
}

/** `journey_states` — one live enrollment per (contact, journey). */
export const UQ_CONTACT_JOURNEY_ACTIVE = "uq_contact_journey_active";

/** `email_preferences` — one row per (contact, email). */
export const UQ_CONTACT_EMAIL_PREFERENCES =
  "email_preferences_contact_email_idx";
