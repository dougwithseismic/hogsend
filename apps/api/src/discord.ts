import type { Database } from "@hogsend/db";
import {
  createColdConnect,
  type DerivedCredentialPayload,
  getDerivedCredential,
  getEmailService,
  type IdentityService,
  saveDerivedCredential,
} from "@hogsend/engine";
import {
  createDiscordConnector,
  DISCORD_PROVIDER_ID,
  type DiscordConnectorWithHandlers,
  discordDestination,
} from "@hogsend/plugin-discord";
import { discordEnv } from "./env.js";

/**
 * Shared Discord registration both `index.ts` (API) and `worker.ts` (Hatchet
 * worker) import, so the container's connector/destination registry singleton is
 * IDENTICAL in both processes (the ingest pipeline runs in the worker too).
 *
 * The `db` problem: the connector is passed INTO `createHogsendClient`, which is
 * what BUILDS `db`. So the connector is constructed with a DEFERRED db getter
 * (`getDb`) that the caller wires to `client.db` AFTER the client is built. The
 * connector's `saveDerived` / `resolveContact` callbacks only ever run at
 * request time (the oauth callback), long after `client.db` is set — so the
 * getter is always resolved by then. `setDiscordDb(client.db)` MUST be called
 * once after `createHogsendClient(...)` returns.
 */

let dbHandle: Database | undefined;
let identityHandle: IdentityService | undefined;

/**
 * Wire the container db handle AND the engine identity service into the Discord
 * callbacks (call once, post-build). `client.identity` is the engine path the
 * `/link` contact-merge propagates a PostHog merge through (§7) — wiring it here
 * keeps the merge propagation in the engine, not bespoke connector code.
 */
export function setDiscordDb(db: Database, identity: IdentityService): void {
  dbHandle = db;
  identityHandle = identity;
}

function requireDb(): Database {
  if (!dbHandle) {
    throw new Error(
      "Discord connector used before setDiscordDb(client.db, …) was called",
    );
  }
  return dbHandle;
}

function requireIdentity(): IdentityService {
  if (!identityHandle) {
    throw new Error(
      "Discord connector used before setDiscordDb(…, client.identity) was called",
    );
  }
  return identityHandle;
}

/**
 * Discord cold-connect flow, built on the engine `createColdConnect()` primitive
 * — the same one Telegram uses (`telegramColdConnect`). The `/link` slash command
 * emails a one-click confirm LINK (NO typed code); clicking it lands on the
 * engine-served `GET /connect/discord` page (mounted via {@link discordColdConnect}
 * `.routes` in `index.ts`), whose button POST runs the exchange: `ingestEvent`
 * folds `discord_id` + email onto ONE contact (returning the canonical
 * `contactKey`), the page CLIENT-identifies (`posthog.identify(contactKey,
 * { discord_id })`), and `discord.linked` is pushed onto the spine.
 *
 * `identityKind: "discordId"` rides the dedicated `contacts.discord_id` column
 * (not the prefixed `external_id` lane Telegram uses), so `platformKey` returns
 * the RAW snowflake — the engine has a collision guard on that column. The
 * anti-email-bomb throttle (Redis-INCR, fail-closed) lives inside `mintConfirm`,
 * so the consumer no longer hand-rolls a `/verify` attempt counter.
 *
 * No `afterBind`: this consumer grants no verified role (it has no
 * `DISCORD_VERIFIED_ROLE_ID` env and no discord-welcome journey — that lives in
 * the dogfood consumer). The OAuth `member_link` branch likewise only
 * `linkContact`s here, so both bind paths stay at parity.
 */
export const discordColdConnect = createColdConnect<Record<string, never>>({
  connectorId: DISCORD_PROVIDER_ID,
  identityKind: "discordId",
  // The dedicated `discord_id` column keys on the raw snowflake — no namespace
  // prefix (unlike Telegram's `telegram:<id>` external_id lane).
  platformKey: (id) => id,
  linkedEvent: "discord.linked",
  identifyPropKey: "discord_id",
  buildIngest: (binding) => ({
    // Scalar trigger properties a `discord.linked` welcome journey would read off
    // `user.properties.*` — `contactProperties` never reach the Hatchet payload.
    eventProperties: {
      source: "discord",
      discordId: binding.platformUserId,
      via: "email_confirm",
    },
    // `discord` is in DEEP_MERGE_KEYS, so this merges with the richer metadata
    // (username/avatar/etc.) inbound gateway events set — it never clobbers them.
    contactProperties: {
      discord: { id: binding.platformUserId },
    },
  }),
  branding: {
    badge: "💬",
    accentColor: "#5865f2",
    title: "Connect your Discord",
    blurb: "Tap below to finish linking your Discord account to your contact.",
    successCopy: {
      heading: "You're connected ✓",
      body: "Your Discord is now linked. You can close this tab and head back to Discord.",
    },
    errorCopy: {
      heading: "Link unavailable",
      body: "This link is invalid or already used. Run /link again in Discord for a fresh one.",
    },
  },
});

/**
 * Build the connect-ready Discord connector. Returns `undefined` when the
 * Discord app id / client secret / public key aren't configured — a deploy with
 * no Discord configured simply registers no connector (the destination is still
 * registered separately; it's config-driven per-endpoint).
 */
export function buildDiscordConnector():
  | DiscordConnectorWithHandlers
  | undefined {
  const applicationId = discordEnv.DISCORD_APPLICATION_ID;
  const clientSecret = discordEnv.DISCORD_CLIENT_SECRET;
  const publicKeyHex = discordEnv.DISCORD_PUBLIC_KEY;
  if (!applicationId || !clientSecret || !publicKeyHex) {
    return undefined;
  }

  const base = discordEnv.API_PUBLIC_URL.replace(/\/$/, "");

  return createDiscordConnector({
    applicationId,
    clientSecret,
    publicKeyHex,
    redirectUri: `${base}/v1/connectors/discord/oauth/callback`,
    // Studio's SPA is mounted at /studio (its router basepath is /studio too),
    // so the integrations page lives at /studio/integrations — NOT /integrations
    // (which 404s at the API root).
    studioIntegrationsUrl: `${base}/studio/integrations`,
    // The derived store is a full-payload OVERWRITE, so read-merge-write to keep
    // any previously-stored fields (e.g. a guild id captured on install must not
    // wipe a bot token persisted earlier).
    saveDerived: async (patch) => {
      const db = requireDb();
      const current =
        (await getDerivedCredential(db, "discord")) ??
        ({} as DerivedCredentialPayload);
      await saveDerivedCredential(db, "discord", {
        ...current,
        ...(patch as DerivedCredentialPayload),
      });
    },
    // Route the snowflake through the engine's `discord` identity Kind so
    // `discord_id` stays the SOLE resolution key; `email` is the AUTHORITATIVE
    // address the link was issued for (from the engine-verified state), never the
    // OAuth-reported Discord email. `contactProperties` is NON-KEY metadata.
    //
    // Goes through `client.identity.linkContact` (NOT bare
    // `resolveOrCreateContact`) so a successful `/link` contact-merge propagates
    // the PostHog merge through the SAME engine emission ingest uses (§7) — the
    // discord-keyed loser is absorbed into the canonical (email/external)
    // survivor (MF-2: an already-identified loser `external_id` is excluded and
    // logged as a residual twin, never aliased). Bare resolveOrCreateContact
    // would merge the rows but leave the Discord-platform events on a separate
    // PostHog person.
    resolveContact: async (patch) => {
      await requireIdentity().linkContact({
        discordId: patch.discordId,
        email: patch.email,
        contactProperties: patch.contactProperties,
      });
    },
    // The `/link` front door: mint a server-sealed cold-connect confirm token
    // (the throttle runs FIRST inside `mintConfirm` — Redis-INCR, fail-closed)
    // and, only on `ok:true`, email the one-click confirm LINK. The handler never
    // sees the token — it lives only in the emailed URL. The bind itself happens
    // later when the user clicks the link (the `discordColdConnect.routes`
    // exchange folds discord_id + email onto one contact). A mailer throw
    // propagates so the interactions loop fails CLOSED (apologetic reply, no
    // link); `ok:false` maps to a neutral `rate_limited`/`unavailable` reason.
    requestConfirm: async ({ discordUserId, email }) => {
      const minted = await discordColdConnect.mintConfirm({
        platformUserId: discordUserId,
        email,
      });
      if (!minted.ok) {
        return {
          ok: false,
          reason:
            minted.reason === "redis_unavailable"
              ? "unavailable"
              : "rate_limited",
        };
      }
      const url = discordColdConnect.confirmUrl({
        apiPublicUrl: base,
        token: minted.token,
      });
      // TRANSACTIONAL send — bypasses unsubscribe/frequency suppression so a
      // confirm link is NEVER silently dropped. No contact exists yet at /link
      // time, so userId is the email (a valid external key; the exchange later
      // folds discord_id + email onto one contact).
      await getEmailService().send({
        template: "transactional/magic-link",
        props: { magicLinkUrl: url, expiresIn: "15 minutes" },
        to: email,
        userId: email,
        userEmail: email,
        subject: "Confirm your Discord connection",
        category: "transactional",
        skipPreferenceCheck: true,
      });
      return { ok: true };
    },
  });
}

/**
 * Seed the env `DISCORD_APPLICATION_ID` into the derived credential at boot, so
 * an ENV-ONLY deploy (app id in env, NO manual `hogsend connect discord`
 * secret-paste) still gets a non-null `derived.discordAppId`.
 *
 * Why this is needed: the install `oauthCallback` (connector.ts) saves ONLY
 * `discordGuildId` — `discordAppId` is written nowhere else. The engine admin
 * routes read `derived.discordAppId` to build `connect-info.installUrl` and to
 * gate `member-link-url` (409 `discord_not_connected` when absent). Without this
 * seed, an env-only deploy shows "Connect via CLI" and 409s on member-link even
 * though the app id is right there in env.
 *
 * Why the consumer (not the engine): the engine env is Discord-agnostic and does
 * NOT carry `DISCORD_APPLICATION_ID` (it lives in the consumer env + the plugin
 * env). Seeding here keeps the engine routes UNCHANGED (they keep reading
 * `derived.discordAppId`) and the engine generic.
 *
 * Read-merge-write via `getDerivedCredential` + `saveDerivedCredential` (the
 * derived store is a full-payload OVERWRITE) so this NEVER clobbers a guild id
 * captured on install or a bot token persisted earlier — it ONLY adds
 * `discordAppId`. Idempotent: a no-op once `discordAppId` already matches, so it
 * never writes on every boot. Call ONLY when a Discord connector was built.
 */
export async function seedDiscordDerived(db: Database): Promise<void> {
  const appId = discordEnv.DISCORD_APPLICATION_ID;
  if (!appId) return;
  const current =
    (await getDerivedCredential(db, "discord")) ??
    ({} as DerivedCredentialPayload);
  if (current.discordAppId === appId) return; // idempotent — avoid a needless write
  await saveDerivedCredential(db, "discord", {
    ...current,
    discordAppId: appId,
  });
}

export { discordDestination };
