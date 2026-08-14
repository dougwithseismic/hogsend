import { contacts, type Database } from "@hogsend/db";
import {
  type AccountLinkHooks,
  type AfterLinkContext,
  type AfterUnlinkContext,
  listLiveLinksForContact,
} from "@hogsend/engine";
import { eq, sql } from "drizzle-orm";

/**
 * Account linking wiring for this app (Steam + Twitch), shared by `index.ts`
 * (API) and `worker.ts` (Hatchet worker) so both containers describe the same
 * deployment.
 *
 * Providers are NOT hardcoded here. The engine's env presets build them:
 * Steam registers on any operator intent and needs no credential, Twitch
 * registers when both `ACCOUNT_LINK_TWITCH_CLIENT_ID` and
 * `ACCOUNT_LINK_TWITCH_CLIENT_SECRET` are set. All this file adds is the
 * in-process hooks.
 *
 * The `db` problem is the one `discord.ts` already has: the hooks are passed
 * INTO `createHogsendClient`, which is what builds `db`. So they read a
 * deferred handle that the caller wires with `setAccountLinkDb(client.db)`
 * after the client is built. The hooks only ever run at request time (the
 * hosted callback, the data plane), long after that call.
 */

let dbHandle: Database | undefined;

/** Wire the container db handle into the hooks (call once, post-build). */
export function setAccountLinkDb(db: Database): void {
  dbHandle = db;
}

/**
 * The property namespace a link writes: `steam_user_id`, `steam_username`,
 * `steam_linked_at`, `steam_link_version`. Scalars on `contacts.properties`, so
 * journeys, buckets and the Studio contact panel read them with no new
 * machinery. The provider id is the prefix, so Twitch writes `twitch_*` and two
 * platforms never collide.
 */
function propertyKeys(provider: string) {
  return {
    userId: `${provider}_user_id`,
    username: `${provider}_username`,
    linkedAt: `${provider}_linked_at`,
    version: `${provider}_link_version`,
  };
}

/**
 * Merge a scalar patch onto `contacts.properties`. A `null` value CLEARS its
 * key rather than storing a JSON null, which is what `jsonb_strip_nulls` buys:
 * one statement serves both the link write and the unlink clear.
 */
async function patchContactProperties(
  db: Database,
  contactId: string,
  patch: Record<string, string | null>,
): Promise<void> {
  await db
    .update(contacts)
    .set({
      properties: sql`jsonb_strip_nulls(COALESCE(${contacts.properties}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb)`,
      updatedAt: new Date(),
    })
    .where(eq(contacts.id, contactId));
}

/**
 * IN-PROCESS hooks. This is the plane that writes into our own database in
 * band: the PULL plane (`/v1/accounts/*`) is the authoritative read and the
 * PUSH plane (outbound `account.*` webhooks) is the retried mirror feed.
 *
 * `afterLink` / `afterUnlink` are post-commit, AT-LEAST-ONCE and fail-open,
 * bounded at 5s (`ACCOUNT_LINK_HOOK_TIMEOUT_MS`), so both hooks below are
 * idempotent: each is a single UPDATE that sets the same keys to the same
 * values, so running it twice leaves the same row. Neither reads the row first,
 * so there is no read-modify-write race either. A throw here is logged and
 * never unwinds the link, and a process that dies mid-hook simply loses the
 * call, so nothing that must not be missed lives in here.
 *
 * `beforeLink` is deliberately absent: this app has no product rule that would
 * refuse a link, and a veto hook is fail-closed, so an unnecessary one only
 * adds a way for links to fail.
 */
export const accountLinkHooks: AccountLinkHooks = {
  async afterLink(ctx: AfterLinkContext) {
    if (!dbHandle) return;
    const keys = propertyKeys(ctx.provider);
    await patchContactProperties(dbHandle, ctx.contactId, {
      [keys.userId]: ctx.identity.providerUserId,
      // Display only, and Steam yields none without STEAM_WEB_API_KEY. Null
      // clears a handle the player has since removed.
      [keys.username]: ctx.identity.username ?? null,
      [keys.linkedAt]: ctx.at,
      // The bigint version as a STRING, never a number: a value above
      // Number.MAX_SAFE_INTEGER rounds through float64 and breaks the
      // `incoming > stored` comparison it exists for. Compare with BigInt().
      [keys.version]: ctx.version,
    });
  },

  async afterUnlink(ctx: AfterUnlinkContext) {
    if (!dbHandle) return;
    const keys = propertyKeys(ctx.provider);

    // These keys are namespaced by PROVIDER, not by pair, while Steam is
    // `multiple: true` (neither `steamAccountLink` nor the call sites set it,
    // and both resolve `provider.multiple ?? true`). So one contact may hold
    // two live Steam links, and clearing unconditionally would wipe the
    // properties while the other link is still live.
    //
    // Derive from committed state instead: only clear when this provider has
    // no live link left on the contact. Still idempotent, because the answer
    // comes from the row set rather than from this call.
    const remaining = await listLiveLinksForContact({
      db: dbHandle,
      contactId: ctx.contactId,
    });
    if (remaining.some((link) => link.provider === ctx.provider)) return;

    // Clear all four on the contact the link LEFT. On a relink the store runs
    // this for the previous owner before `afterLink` for the new one, so the
    // property lands on exactly one contact.
    await patchContactProperties(dbHandle, ctx.contactId, {
      [keys.userId]: null,
      [keys.username]: null,
      [keys.linkedAt]: null,
      [keys.version]: null,
    });
  },
};

/**
 * Passing `accountLinks` at all is operator intent: the engine then registers
 * the credential-free Steam provider, which puts a live, unauthenticated
 * `/v1/accounts/steam/start` on the deploy. So this app passes the option only
 * when an account-link env var is already set, and a deploy that never asked
 * for account linking keeps exactly the surface it has today.
 *
 * These are the same vars the engine's own intent gate reads
 * (`lib/account-links-from-env.ts`). Presence is all that is checked here; the
 * engine validates the values.
 */
export const accountLinks: { hooks: AccountLinkHooks } | undefined = [
  "ACCOUNT_LINK_ALLOWED_ORIGINS",
  "ACCOUNT_LINK_TWITCH_CLIENT_ID",
  "ACCOUNT_LINK_TWITCH_CLIENT_SECRET",
  "STEAM_WEB_API_KEY",
].some((name) => process.env[name])
  ? { hooks: accountLinkHooks }
  : undefined;
