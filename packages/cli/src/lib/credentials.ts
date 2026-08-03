import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * `~/.hogsend/credentials.json` — the only place a CLI session token is ever
 * written, and the only module that writes it.
 *
 * Three rules, each of which is a failure mode somebody has actually shipped:
 *
 *  1. **0600, on create AND on rewrite.** `writeFileSync`'s `mode` is applied
 *     only when the file is CREATED; an existing file keeps whatever mode it
 *     had. So a file that was once 0644 (a botched restore, a synced dotfiles
 *     repo, a `umask 0`) would silently stay world-readable through every
 *     subsequent login. Every write here goes through a fresh temp file and an
 *     explicit `chmod`, so the mode is asserted rather than assumed.
 *  2. **Atomic.** The token is written to a temp file in the SAME directory
 *     and `rename`d over the target — an atomic replace on every platform that
 *     matters. A crash mid-write leaves either the old credentials or the new
 *     ones, never a truncated JSON file that makes every subsequent command
 *     fail with a parse error the user cannot read their way out of.
 *  3. **Keyed by cloud host.** One machine may be logged into the managed
 *     cloud and a self-hosted one at once, and a token minted by one must never
 *     be sent to the other. The host is the key; there is no "current cloud"
 *     pointer to go stale.
 *
 * A malformed or unreadable file reads as EMPTY rather than throwing: the
 * correct response to "I cannot read your credentials" is "run `hogsend
 * login`", not a stack trace. A write, by contrast, throws loudly — a login
 * that silently failed to persist would be the worst outcome of all.
 */

/** The per-cloud entry. Nothing here is rendered except the labels. */
export interface CloudCredential {
  /** The `hscli_…` session token. NEVER printed, logged, or put in --json. */
  token: string;
  /** The human this session belongs to, for `whoami` without a round trip. */
  userLabel?: string;
  /** The organization it is bound to. Same purpose. */
  orgLabel?: string;
  /** ISO timestamp of when this machine stored it. */
  createdAt: string;
}

export interface CredentialsFile {
  clouds: Record<string, CloudCredential>;
}

/** The one mode this file is ever allowed to have. */
export const CREDENTIALS_MODE = 0o600;

const EMPTY: CredentialsFile = { clouds: {} };

/** `~/.hogsend` — overridable so tests never touch a real home directory. */
export function credentialsDir(home: string = homedir()): string {
  return join(home, ".hogsend");
}

export function credentialsPath(home: string = homedir()): string {
  return join(credentialsDir(home), "credentials.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Coerce whatever is on disk into the shape, dropping anything malformed. */
function parse(raw: string): CredentialsFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { clouds: {} };
  }
  if (!isRecord(parsed) || !isRecord(parsed.clouds)) return { clouds: {} };

  const clouds: Record<string, CloudCredential> = {};
  for (const [host, entry] of Object.entries(parsed.clouds)) {
    if (!isRecord(entry)) continue;
    if (typeof entry.token !== "string" || entry.token.length === 0) continue;
    clouds[host.toLowerCase()] = {
      token: entry.token,
      ...(typeof entry.userLabel === "string"
        ? { userLabel: entry.userLabel }
        : {}),
      ...(typeof entry.orgLabel === "string"
        ? { orgLabel: entry.orgLabel }
        : {}),
      createdAt:
        typeof entry.createdAt === "string"
          ? entry.createdAt
          : new Date(0).toISOString(),
    };
  }
  return { clouds };
}

/** Everything stored, or an empty file. Never throws. */
export function readCredentials(home: string = homedir()): CredentialsFile {
  const file = credentialsPath(home);
  if (!existsSync(file)) return { ...EMPTY, clouds: {} };
  try {
    return parse(readFileSync(file, "utf8"));
  } catch {
    return { ...EMPTY, clouds: {} };
  }
}

/** The stored session for one cloud host, or undefined. */
export function readCloudCredential(
  host: string,
  home: string = homedir(),
): CloudCredential | undefined {
  return readCredentials(home).clouds[host.toLowerCase()];
}

/**
 * Replace the whole file, atomically, at 0600.
 *
 * The temp file is created with `wx` (exclusive) under a random name in the
 * destination directory, chmod'ed, then renamed. Same-directory so the rename
 * cannot cross a filesystem boundary and degrade into a copy.
 */
export function writeCredentials(
  next: CredentialsFile,
  home: string = homedir(),
): void {
  const file = credentialsPath(home);
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const tmp = join(dir, `.credentials.${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, {
      mode: CREDENTIALS_MODE,
      flag: "wx",
    });
    // Belt to the braces: `mode` above is honoured only on create and is
    // masked by the process umask. This is the assertion.
    chmodSync(tmp, CREDENTIALS_MODE);
    renameSync(tmp, file);
    // And again on the destination, because `rename` preserves the SOURCE
    // inode's mode — which is right — but a hostile pre-existing target with a
    // different mode would be replaced, not merged. Asserting after the rename
    // costs one syscall and closes the question permanently.
    chmodSync(file, CREDENTIALS_MODE);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

/** Store (or replace) the session for one cloud host. */
export function writeCloudCredential(
  host: string,
  credential: CloudCredential,
  home: string = homedir(),
): void {
  const current = readCredentials(home);
  writeCredentials(
    {
      clouds: { ...current.clouds, [host.toLowerCase()]: credential },
    },
    home,
  );
}

/**
 * Forget one cloud host. Returns whether there was anything to forget, so
 * `hogsend logout` can say "you were not logged in" truthfully.
 */
export function deleteCloudCredential(
  host: string,
  home: string = homedir(),
): boolean {
  const key = host.toLowerCase();
  const current = readCredentials(home);
  if (!(key in current.clouds)) return false;
  const { [key]: _removed, ...rest } = current.clouds;
  writeCredentials({ clouds: rest }, home);
  return true;
}
