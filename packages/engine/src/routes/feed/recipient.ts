import { contacts, type Database } from "@hogsend/db";
import { and, eq, isNull, or } from "drizzle-orm";
import type { Context } from "hono";
import type { AppEnv } from "../../app.js";
import {
  contactKey,
  normalizeEmail,
  resolveContact,
} from "../../lib/contacts.js";
import {
  InvalidUserTokenError,
  verifyUserToken,
} from "../../lib/user-token.js";

export type FeedRecipient =
  | { ok: true; recipientKey: string; contactId?: string }
  | { ok: false; status: 400 | 403; error: string };

export interface FeedRecipientParams {
  userId?: string;
  email?: string;
  anonymousId?: string;
  userToken?: string;
}

/**
 * THE SECURITY CORE. Derive the SERVER-TRUSTED `recipientKey` for a feed request.
 * NEVER reads `recipientKey` (or any key it returns) from the request body/query
 * directly — every value is either token-verified or a self-addressing anon id.
 *
 *  - `userToken` present (works for publishable AND secret callers): verify the
 *    HMAC (`BETTER_AUTH_SECRET`); recipientKey = canonical key for the token's
 *    `userId`. A forged/expired token → 403.
 *  - SECRET key (`!publishable`) with `userId`/`email`: server-trusted, resolve
 *    its canonical key directly.
 *  - PUBLISHABLE + `anonymousId` (no token): recipientKey = the RAW anon id. It
 *    is NOT passed through the contact resolver — the resolver can fold an anon
 *    id into an identified survivor's canonical key, and returning that would let
 *    an anon caller (who only knows its own browser anon id) read an identified
 *    person's feed. The raw anon id can only ever match feed rows `sendFeedItem`
 *    wrote under that same anon id — UNLESS the supplied value is some identified
 *    contact's canonical key (`external_id`/`email`). `sendFeedItem` stores an
 *    identified recipient's rows under `external_id ?? anonymous_id ?? id`, so a
 *    token-less pk_ caller passing `anonymousId=<victim external_id|email>` would
 *    otherwise read/mutate that victim's feed. Mirroring the events route's
 *    `PublishableAnonymousMergeError` invariant, we reject a publishable
 *    `anonymousId` that collides with an identified contact's key → 403.
 *  - else (publishable, no identity) → 400 fail-closed.
 *
 * There is no path where a caller's request-supplied recipientKey is honored.
 */
export async function resolveFeedRecipient(
  c: Context<AppEnv>,
  params: FeedRecipientParams,
): Promise<FeedRecipient> {
  const { db, env } = c.get("container");
  const publishable = c.get("publishable") === true;

  // 1. Token path — the ONLY thing that authorizes a concrete userId for a
  //    publishable caller (and accepted from a secret caller too).
  if (params.userToken) {
    let userId: string;
    try {
      userId = verifyUserToken({
        token: params.userToken,
        secret: env.BETTER_AUTH_SECRET,
      }).userId;
    } catch (err) {
      if (err instanceof InvalidUserTokenError) {
        return { ok: false, status: 403, error: "Invalid userToken" };
      }
      throw err;
    }
    const ck = await canonicalKey(db, { userId });
    return { ok: true, recipientKey: ck.recipientKey, contactId: ck.contactId };
  }

  // 2. Secret key: trust userId/email directly.
  if (!publishable && (params.userId || params.email)) {
    const ck = await canonicalKey(db, {
      userId: params.userId,
      email: params.email,
    });
    return { ok: true, recipientKey: ck.recipientKey, contactId: ck.contactId };
  }

  // 3. Publishable anon: its raw anon id IS its recipientKey (no resolver — see
  //    the doc comment's fold hazard). But a token-less publishable caller may
  //    only address its OWN browser anon id — NEVER an identified contact's
  //    canonical key. `sendFeedItem` stores an identified recipient's feed rows
  //    under `external_id ?? email`-derived key, so reject any `anonymousId` that
  //    collides with an identified contact's key (mirrors the events route's
  //    `restrictToAnonymous` / `PublishableAnonymousMergeError` invariant).
  if (params.anonymousId) {
    if (publishable && (await collidesWithIdentified(db, params.anonymousId))) {
      return {
        ok: false,
        status: 403,
        error: "anonymousId is not addressable",
      };
    }
    // Surface the anon contact's row id (when it exists) as engine-internal
    // provenance. The feed's OWN mark/clear re-ingests (emitMarkEvents,
    // inapp.feed_cleared) re-ingest keyed `userId: recipientKey` = this raw anon
    // id; threading the row id makes them fold into THIS contact by id instead of
    // minting a phantom `external_id=<anonId>` twin — the twin that then trips
    // collidesWithIdentified and 403-locks the visitor out of their own feed.
    const anonRow = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(
        and(
          eq(contacts.anonymousId, params.anonymousId),
          isNull(contacts.deletedAt),
        ),
      )
      .limit(1);
    return {
      ok: true,
      recipientKey: params.anonymousId,
      contactId: anonRow[0]?.id,
    };
  }

  // 4. No identity → fail-closed.
  return {
    ok: false,
    status: 400,
    error: "anonymousId, userId, email, or userToken is required",
  };
}

/**
 * True when `value` is the canonical key of an IDENTIFIED contact — i.e. a live
 * contact's `external_id`, or its `email` when that is its canonical key (no
 * `external_id`). Such a value names an identified person's feed rows, so a
 * token-less publishable caller must NOT be allowed to claim it as an "anon id".
 *
 * A genuine browser anon id only ever matches a contact via `anonymous_id` whose
 * canonical key is that same anon id (the contact has no `external_id`) — that is
 * the caller's OWN anon contact and is allowed (returns false).
 *
 * Exported for the arrive endpoint (`POST /v1/t/arrive`), which must run the
 * SAME check before stamping an anon value onto a click row — otherwise
 * `{ ref, anonymousId: "<victim key>" }` would forge "victim arrived here".
 */
export async function collidesWithIdentified(
  db: Database,
  value: string,
): Promise<boolean> {
  const rows = await db
    .select({
      externalId: contacts.externalId,
      email: contacts.email,
      anonymousId: contacts.anonymousId,
    })
    .from(contacts)
    .where(
      and(
        or(
          eq(contacts.externalId, value),
          eq(contacts.email, value),
          eq(contacts.anonymousId, value),
        ),
        isNull(contacts.deletedAt),
      ),
    );
  for (const row of rows) {
    // The supplied value is this contact's `external_id` → its rows are keyed on
    // it (identified). Reject.
    if (row.externalId === value) return true;
    // The supplied value is this contact's `email` AND that email is its
    // canonical key (no external_id) → identified rows are keyed on it. Reject.
    if (row.email === value && !row.externalId) return true;
  }
  return false;
}

/**
 * Canonical key (`external_id ?? anonymous_id ?? id`) for a known contact. Prefer
 * an `email` match (most specific send target), then `userId` (external id or
 * uuid via `resolveContact`). When no contact exists yet, key on the asserted
 * identifier — a future `sendFeedItem({ recipient: { userId/email } })` resolves
 * to a contact whose canonical key is that same value, so the two agree.
 */
async function canonicalKey(
  db: Database,
  ident: { userId?: string; email?: string },
): Promise<{ recipientKey: string; contactId?: string }> {
  if (ident.email) {
    const email = normalizeEmail(ident.email);
    const rows = await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.email, email), isNull(contacts.deletedAt)))
      .limit(1);
    if (rows[0])
      return { recipientKey: contactKey(rows[0]), contactId: rows[0].id };
    return { recipientKey: email };
  }
  if (ident.userId) {
    const row = await resolveContact({ db, id: ident.userId });
    if (row) return { recipientKey: contactKey(row), contactId: row.id };
    return { recipientKey: ident.userId };
  }
  return { recipientKey: "" };
}
