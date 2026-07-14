import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { confirm } from "@clack/prompts";
import { apiKeys, createDatabase } from "@hogsend/db";
import { loadDotEnv } from "./config.js";
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

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** True when the base URL points at this machine. */
export function isLocalBaseUrl(baseUrl: string): boolean {
  try {
    return LOCAL_HOSTNAMES.has(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

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

/** Replace a commented/live `KEY=...` line, or append one. */
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
  if (!isLocalBaseUrl(opts.baseUrl)) return undefined;
  if (!existsSync(envPath)) return undefined;
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

  // Mirrors the engine's `generateApiKey`/`hashApiKey`: hsk_<32B base64url>,
  // sha256-hex at rest, first 8 chars stored as the display prefix.
  const key = `hsk_${randomBytes(32).toString("base64url")}`;
  const keyPrefix = key.slice(0, 8);
  const keyHash = createHash("sha256").update(key).digest("hex");

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
