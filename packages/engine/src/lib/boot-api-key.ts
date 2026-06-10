import { apiKeys } from "@hogsend/db";
import { sql } from "drizzle-orm";
import type { HogsendClient } from "../container.js";
import { generateApiKey } from "./api-key-hash.js";

/** Name of the key minted by the first-boot bootstrap (visible in Studio/admin). */
export const BOOTSTRAP_API_KEY_NAME = "bootstrap-ingest";

/**
 * Boot-time first-key bootstrap — the data-plane sibling of
 * `bootstrapAdminFromEnv` (lib/bootstrap-admin.ts). A local scaffold runs
 * `pnpm bootstrap`, which mints an ingest-scoped `hsk_` key into `api_keys`
 * BEFORE first boot — but a template deploy (Railway) never runs that script,
 * so a fresh deployed instance has NO data-plane key and the customer's first
 * `POST /v1/events` has nothing to authenticate with. This closes that gap.
 *
 * Contract (all conditions must hold to mint):
 *  - `HOGSEND_BOOTSTRAP_API_KEY` is not `"false"` (default on; set `false` to
 *    opt out entirely).
 *  - The `api_keys` table has ZERO rows — revoked included, i.e. truly first
 *    boot. Any existing row (including the local-bootstrap key) ⇒ no-op, so
 *    the full key is naturally never logged twice.
 *
 * What is minted: one key named `bootstrap-ingest` with `scopes: ["ingest"]`
 * — exactly what the scaffold's local bootstrap mints. Only the sha256 hash is
 * stored (same `generateApiKey` the admin api-keys route uses); the FULL key is
 * printed ONCE to the server log at warn level — the same intended
 * secret-logging exception as the generated first-admin password ("shown
 * once"). Rotate/revoke it any time via `POST /v1/admin/api-keys`.
 *
 * Concurrency: unlike the admin bootstrap there is no unique constraint to
 * break a tie (two replicas would mint two different keys), so the zero-check +
 * insert runs in a transaction serialized by a pg advisory xact lock — exactly
 * one key is ever minted on a fresh table. Never fatal: any failure is logged
 * and boot continues (the admin API remains the manual path).
 *
 * Runs in the API process only (not the worker) — same boot path as
 * `bootstrapAdminFromEnv`, after the schema guard.
 */
export async function bootstrapApiKeyFromEnv(opts: {
  client: HogsendClient;
}): Promise<void> {
  const { db, env, logger } = opts.client;

  if (env.HOGSEND_BOOTSTRAP_API_KEY === "false") return;

  try {
    // Cheap pre-check outside the transaction: every boot after the first
    // returns here without taking the lock.
    const existing = await db.select({ id: apiKeys.id }).from(apiKeys).limit(1);
    if (existing.length > 0) return;

    const minted = await db.transaction(async (tx) => {
      // Serialize concurrent replicas booting on a fresh DB: the loser blocks
      // here, then sees the winner's row and no-ops. Lock is released on commit.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext('hogsend:bootstrap-api-key'))`,
      );

      const recheck = await tx
        .select({ id: apiKeys.id })
        .from(apiKeys)
        .limit(1);
      if (recheck.length > 0) return null;

      const { key, prefix, hash } = generateApiKey();
      await tx.insert(apiKeys).values({
        name: BOOTSTRAP_API_KEY_NAME,
        keyPrefix: prefix,
        keyHash: hash,
        scopes: ["ingest"],
        createdBy: "boot",
      });
      return key;
    });

    if (!minted) {
      logger.debug(
        "[api-keys] First-boot key bootstrap skipped: a key already exists.",
      );
      return;
    }

    // The intended secret-logging exception (mirrors the generated first-admin
    // password). Shown once — the table is non-empty from now on, so this
    // branch is unreachable on every subsequent boot.
    logger.warn(
      `[api-keys] First-boot ingest API key (shown once — save it now): ${minted}`,
    );
    logger.warn(
      "[api-keys] Use it as HOGSEND_API_KEY / `Authorization: Bearer <key>` " +
        "for POST /v1/events. Rotate or revoke via POST /v1/admin/api-keys. " +
        "Disable this bootstrap with HOGSEND_BOOTSTRAP_API_KEY=false.",
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("[api-keys] First-boot key bootstrap failed.", {
      error: message,
    });
  }
}
