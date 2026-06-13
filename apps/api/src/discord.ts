import type { Database } from "@hogsend/db";
import {
  type DerivedCredentialPayload,
  getDerivedCredential,
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
    studioIntegrationsUrl: `${base}/integrations`,
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
  });
}

export { discordDestination };
