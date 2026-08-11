import { and, eq } from "drizzle-orm";
import type { CloudDb } from "../db";
import { db as defaultDb } from "../db";
import { environments, providerKeys } from "../db/schema";
import { decryptSecretPayload, encryptSecretPayload } from "../lib/crypto";
import type { DkimKeypair } from "../lib/sending-domains";
import { HOGSEND_DKIM_SELECTOR } from "../lib/sending-domains";
import type { CloudWriter } from "./audit";
import { NotFoundError } from "./errors";

/**
 * Where a domain's DKIM PRIVATE KEY lives, and the only module that can read
 * one back.
 *
 * `provider_keys` is the store, deliberately (PRD 07): AES-256-GCM under
 * `CLOUD_ENCRYPTION_SECRET`, one row per (environment, provider), cascaded on
 * environment delete, ciphertext-only at rest. Inventing a second secret store
 * for one more secret would double the number of places a rotation has to
 * reach.
 *
 * Three rules, each of which is a decision rather than a detail:
 *
 *  - **`last4` stays NULL.** The rest of `provider_keys` fills it so a settings
 *    screen can show "…a91f" for a credential the tenant pasted themselves.
 *    Nothing renders a DKIM key — the settings page iterates the fixed
 *    `PROVIDER_FORMS` catalog, which this pseudo-provider is deliberately not
 *    in — so a display tail would be four characters of a private key stored
 *    for no reader at all. That is why this module writes the row directly
 *    instead of going through `ProviderKeyService.store()`, which derives
 *    `last4` from the longest value in the payload.
 *  - **The payload is FLAT `Record<string, string>`.** `key-sync.ts` lists and
 *    DECRYPTS every credential row for an environment on every sync, and
 *    `ProviderKeyService.getDecrypted` zod-parses each one as a flat string map
 *    — so a nested payload here would throw on a code path that has nothing to
 *    do with domains. `provider-env.ts` maps unknown providers to no env vars
 *    at all ("Unknown providers contribute nothing"), so the row rides along
 *    inertly.
 *  - **One row per ENVIRONMENT, keyed inside by domain.** The unique index is
 *    `(environment_id, provider)` and a domain cannot be spelled as a provider
 *    id (the schema is `^[a-z0-9][a-z0-9_-]*$`; domains have dots). A
 *    read-modify-write therefore has to be serialised, which is what the
 *    environment-row lock in {@link writeDkimKey} is for.
 *
 * The selector is stored alongside the key rather than assumed, so a future
 * rotation can publish a second selector before retiring the first. Rotating is
 * out of scope for this wave; carrying the column is not.
 */

/** The pseudo-provider id this module owns. Never in `PROVIDER_FORMS`. */
export const HOGSEND_DKIM_PROVIDER = "hogsend-dkim";

/**
 * `|` is not legal in a domain name, so it cannot collide with one, and it
 * keeps the payload a flat map the way `key-sync` needs.
 */
function payloadField(domain: string, field: string): string {
  return `${domain}|${field}`;
}

export interface DkimKeyDeps {
  db?: CloudDb;
}

/**
 * This environment's stored key for one domain, or `null`.
 *
 * The ONLY read path for the private half. A caller that wants to render the
 * DKIM record needs `publicKey`; nothing but `createIdentity` may touch
 * `privateKey`.
 */
export async function readDkimKey(
  input: { environmentId: string; domain: string },
  deps: DkimKeyDeps = {},
): Promise<DkimKeypair | null> {
  const db = deps.db ?? defaultDb;
  const payload = await readPayload(db, input.environmentId);
  if (!payload) return null;

  const privateKey = payload[payloadField(input.domain, "private")];
  const publicKey = payload[payloadField(input.domain, "public")];
  if (!privateKey || !publicKey) return null;

  return {
    selector:
      payload[payloadField(input.domain, "selector")] ?? HOGSEND_DKIM_SELECTOR,
    privateKey,
    publicKey,
  };
}

/**
 * Record a domain's keypair, merging into whatever this environment already
 * holds.
 *
 * Serialised on the ENVIRONMENT row rather than left to the upsert, because the
 * merge is a read-modify-write: two concurrent `create`s for two different
 * domains would otherwise both read the same payload and the second write would
 * silently drop the first domain's key — and a dropped private key is a domain
 * whose published TXT record can never be re-derived.
 *
 * Existing entries are NEVER overwritten. A second keypair for a domain the
 * customer has already published a record for would invalidate that record, so
 * the write is add-only and `create` reuses whatever is already here.
 */
export async function writeDkimKey(
  input: { environmentId: string; domain: string; keypair: DkimKeypair },
  deps: DkimKeyDeps = {},
): Promise<void> {
  const db = deps.db ?? defaultDb;

  await db.transaction(async (tx) => {
    const [environment] = await tx
      .select({ organizationId: environments.organizationId })
      .from(environments)
      .where(eq(environments.id, input.environmentId))
      .limit(1)
      .for("update");
    if (!environment) {
      throw new NotFoundError("Environment", input.environmentId);
    }

    const current = (await readPayload(tx, input.environmentId)) ?? {};
    // Add-only: a stored key wins over the one offered.
    if (current[payloadField(input.domain, "private")]) return;

    const payload: Record<string, string> = {
      ...current,
      [payloadField(input.domain, "selector")]: input.keypair.selector,
      [payloadField(input.domain, "private")]: input.keypair.privateKey,
      [payloadField(input.domain, "public")]: input.keypair.publicKey,
    };

    const values = {
      organizationId: environment.organizationId,
      environmentId: input.environmentId,
      provider: HOGSEND_DKIM_PROVIDER,
      encryptedPayload: encryptSecretPayload(payload),
      // Deliberately null — see the module note.
      last4: null,
    };
    await tx
      .insert(providerKeys)
      .values(values)
      .onConflictDoUpdate({
        target: [providerKeys.environmentId, providerKeys.provider],
        set: {
          encryptedPayload: values.encryptedPayload,
          last4: null,
          updatedAt: new Date(),
        },
      });
  });
}

async function readPayload(
  writer: CloudWriter,
  environmentId: string,
): Promise<Record<string, string> | null> {
  const [row] = await writer
    .select({ encryptedPayload: providerKeys.encryptedPayload })
    .from(providerKeys)
    .where(
      and(
        eq(providerKeys.environmentId, environmentId),
        eq(providerKeys.provider, HOGSEND_DKIM_PROVIDER),
      ),
    )
    .limit(1);
  if (!row) return null;
  return decryptSecretPayload<Record<string, string>>(row.encryptedPayload);
}
