/**
 * Cookie namespace for the control plane's Better Auth.
 *
 * MUST NOT be "hogsend" — that prefix belongs to the ENGINE's Better Auth
 * (`packages/engine/src/lib/auth.ts`). Both apps are served under
 * `*.hogsend.com`, and a shared cookie NAME across two different databases is
 * exactly the bug that produced the Studio login loop: the browser delivers the
 * sibling cookie, it resolves to a null session, and login never sticks.
 * Prefix-only — the Domain attribute is left unset, so the cookie stays
 * host-only.
 *
 * Kept in its own module, free of any import, because the EDGE middleware reads
 * it: importing it from `./auth` would drag the Postgres driver into the
 * middleware bundle.
 */
export const CLOUD_COOKIE_PREFIX = "hscloud";

/** The session cookie Better Auth issues under {@link CLOUD_COOKIE_PREFIX}. */
export const CLOUD_SESSION_COOKIE_NAME = `${CLOUD_COOKIE_PREFIX}.session_token`;
