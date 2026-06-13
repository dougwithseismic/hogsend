import type { Database } from "@hogsend/db";
import {
  createLinkCode,
  type DerivedCredentialPayload,
  getDerivedCredential,
  getEmailService,
  getRedisIfConnected,
  redeemLinkCode,
  resolveOrCreateContact,
  saveDerivedCredential,
} from "@hogsend/engine";
import {
  createDiscordConnector,
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

/** Wire the container db handle into the Discord callbacks (call once, post-build). */
export function setDiscordDb(db: Database): void {
  dbHandle = db;
}

function requireDb(): Database {
  if (!dbHandle) {
    throw new Error(
      "Discord connector used before setDiscordDb(client.db) was called",
    );
  }
  return dbHandle;
}

/** Redis key prefix for the `/verify` anti-guessing attempt counter. */
const VERIFY_ATTEMPT_PREFIX = "hogsend:discord:verifyattempts:u:";
/** Rolling window (seconds) and cap for the `/verify` attempt throttle. */
const VERIFY_ATTEMPT_WINDOW_SECONDS = 900;
const VERIFY_ATTEMPT_MAX = 10;

/**
 * Anti-guessing `/verify` throttle: INCR a per-Discord-user counter with a
 * rolling 15-min TTL, throttle once it exceeds the cap. Best-effort — when Redis
 * is not connected this skips (returns not-throttled); redeem is still
 * single-use + identity-bound, so this only blunts CPU/store abuse from
 * brute-force `/verify` traffic, never gates correctness.
 */
async function recordVerifyAttempt(args: {
  discordUserId: string;
}): Promise<{ throttled: boolean }> {
  const redis = getRedisIfConnected();
  if (!redis) return { throttled: false };
  const key = `${VERIFY_ATTEMPT_PREFIX}${args.discordUserId}`;
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, VERIFY_ATTEMPT_WINDOW_SECONDS);
  return { throttled: n > VERIFY_ATTEMPT_MAX };
}

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
    resolveContact: async (patch) => {
      await resolveOrCreateContact({
        db: requireDb(),
        discordId: patch.discordId,
        email: patch.email,
        contactProperties: patch.contactProperties,
      });
    },
    // Mint a single-use code via the engine's table-backed store — the
    // anti-email-bomb throttle (per invoking user AND per target email) runs
    // FIRST inside createLinkCode; over-cap returns { ok:false } with no mint.
    // A DB error throws and propagates so the loop fails CLOSED (no send).
    mintCode: async ({ discordUserId, email }) => {
      const result = await createLinkCode({
        db: requireDb(),
        connectorId: "discord",
        platformUserId: discordUserId,
        email,
      });
      return result.ok
        ? { ok: true, code: result.code }
        : { ok: false, reason: "throttled" };
    },
    // TRANSACTIONAL send — bypasses unsubscribe/frequency suppression so a
    // verification code is NEVER silently dropped. Routing through `sendEmail`
    // would force category:"journey" and drop the code for unsubscribed users.
    // No contact exists yet at /link time, so userId is the email (a valid
    // external key; /verify later folds email→contact).
    sendLinkCode: async ({ email, code }) => {
      await getEmailService().send({
        template: "transactional/discord-link-code",
        props: { code },
        to: email,
        userId: email,
        userEmail: email,
        subject: "Your Discord verification code",
        category: "transactional",
        skipPreferenceCheck: true,
      });
    },
    // Redeem a typed code — single-use (atomic claim), TTL-enforced, and
    // identity-bound (the engine re-checks platformUserId, constant-time).
    redeemCode: async ({ discordUserId, code }) => {
      return redeemLinkCode({
        db: requireDb(),
        connectorId: "discord",
        platformUserId: discordUserId,
        code,
      });
    },
    recordVerifyAttempt,
  });
}

export { discordDestination };
