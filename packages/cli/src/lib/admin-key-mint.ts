import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { confirm } from "@clack/prompts";
import { apiKeys, createDatabase } from "@hogsend/db";
// Dependency-free engine subpath (node:crypto only) — the SAME generator the
// engine's admin route and boot mint use, so the key shape can never drift.
import { generateApiKey } from "@hogsend/engine/api-key-hash";
import { loadDotEnv } from "./config.js";
import { isLoopbackUrl } from "./loopback-url.js";
import type { Output } from "./output.js";
import { color } from "./output.js";
import { bail } from "./prompt.js";

/**
 * Self-service fallback for the local no-admin-key dead-end.
 *
 * A fresh scaffold whose bootstrap predates admin-key minting (or a user who
 * skipped bootstrap) hits admin-gated commands with nothing but "no admin key
 * configured" — a wall, mid-onboarding. When the situation is provably the
 * local-dev one (target is localhost AND `./.env` holds a DATABASE_URL), we can
 * do better: offer to mint a `full-admin` key straight into the database — the
 * same shell-gated trust model as `hogsend studio admin create` (holding the
 * DB URL IS the credential) — and persist it to `.env` for every later run.
 *
 * Never fires against a remote `--url` target: a key minted into the LOCAL
 * database is useless against someone else's instance. Never mints without an
 * interactive confirmation.
 */

/**
 * The full "how do I get an admin key" story, used when the mint fallback
 * doesn't apply (remote target, no .env, declined, non-interactive).
 */
export function adminKeyGuidance(baseUrl: string): string {
  return [
    "no admin key configured.",
    "",
    `  Local instance (${color.cyan("localhost")}):`,
    "    Run this from your app directory — `pnpm bootstrap` mints",
    "    HOGSEND_ADMIN_KEY into .env (idempotent, safe to re-run).",
    "",
    `  Deployed instance (${color.cyan(baseUrl)}):`,
    "    Set ADMIN_API_KEY in the instance's environment (e.g. Railway",
    "    variables), then pass it here: --admin-key <key>, or export",
    "    HOGSEND_ADMIN_KEY before running.",
  ].join("\n");
}

/**
 * Replace a commented/live `KEY=...` line, or append one. (setup-steps.ts has
 * a superficially similar edit with DIFFERENT semantics — placeholder-aware,
 * line-array preserving — so the two are deliberately not unified.)
 */
function setEnvLine(content: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const re = new RegExp(`^#?\\s*${key}=.*$`, "m");
  if (re.test(content)) return content.replace(re, line);
  return `${content.replace(/\n*$/, "\n")}${line}\n`;
}

/**
 * Offer to mint a `full-admin` API key into the local database and persist it
 * as `HOGSEND_ADMIN_KEY` in `./.env`. Returns the raw key on success, undefined
 * when the fallback doesn't apply (caller should fail with
 * {@link adminKeyGuidance}). Interactive-only — silent credential creation is
 * never okay.
 */
export async function maybeMintLocalAdminKey(opts: {
  baseUrl: string;
  out: Output;
  cwd?: string;
}): Promise<string | undefined> {
  const cwd = opts.cwd ?? process.cwd();
  const envPath = join(cwd, ".env");
  if (!opts.out.interactive) return undefined;
  if (!isLoopbackUrl(opts.baseUrl)) return undefined;
  // loadDotEnv returns {} for a missing/unreadable .env — one probe covers
  // both "no .env here" and "no DATABASE_URL in it".
  const databaseUrl = loadDotEnv(cwd).DATABASE_URL;
  if (!databaseUrl) return undefined;

  const wanted = bail(
    await confirm({
      message:
        "No admin key configured. Mint a full-admin key into .env now? " +
        "(inserts into api_keys via the DATABASE_URL in ./.env)",
      initialValue: true,
    }),
  );
  if (!wanted) return undefined;

  const { key, prefix: keyPrefix, hash: keyHash } = generateApiKey();

  const { db, client } = createDatabase({ url: databaseUrl });
  try {
    await db.insert(apiKeys).values({
      name: "cli-admin",
      keyPrefix,
      keyHash,
      scopes: ["full-admin"],
      createdBy: "hogsend-cli",
    });
  } catch (err) {
    opts.out.log(
      color.yellow(
        `couldn't mint an admin key: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    return undefined;
  } finally {
    await client.end({ timeout: 5 }).catch(() => {});
  }

  writeFileSync(
    envPath,
    setEnvLine(readFileSync(envPath, "utf8"), "HOGSEND_ADMIN_KEY", key),
  );
  opts.out.log(
    `${color.green("✓")} Minted a full-admin key (${keyPrefix}…) → HOGSEND_ADMIN_KEY in .env`,
  );
  return key;
}
