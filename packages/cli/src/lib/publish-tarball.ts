import type { Dirent } from "node:fs";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { type IgnoreScope, isIgnored, parseIgnoreFile } from "./gitignore.js";

/**
 * The publish archive: which files leave this machine, and the bytes that
 * carry them.
 *
 * THE HARD EXCLUDES ARE THE POINT. `.git`, `node_modules`, `dist` and every
 * `.env*` are dropped BEFORE `.gitignore` is consulted, at ANY depth, and
 * nothing a repository contains can re-include them:
 *
 *  - `.env*` because it is where every scaffold keeps its provider keys, its
 *    database URL and its auth secret. A tenant's `.gitignore` normally covers
 *    it — but "normally" is not a security property, and a tarball is uploaded
 *    to a shared build host and kept as an artifact. This exclusion is the only
 *    thing between a mis-ordered `!.env` and a leaked Resend key;
 *  - `node_modules` and `dist` because the build installs and compiles from
 *    source on the far side. Shipping them is at best tens of megabytes of
 *    waste against a 64MB cap, and at worst a platform-specific binary that
 *    breaks the build it was meant to speed up;
 *  - `.git` because history is not source. It carries every secret ever
 *    committed and then removed, every branch, and often more bytes than the
 *    working tree.
 *
 * The archive is a plain ustar `.tar.gz` built in memory (a scaffold is a few
 * MB and the cap is 64MB, so streaming would buy nothing but complexity), with
 * entries sorted by path and a fixed mtime — the same tree produces the same
 * bytes, which makes "did anything actually change" answerable. Only regular
 * files are emitted: directories are implied by their contents (the control
 * plane's unpacker `mkdir -p`s each entry's parent) and symlinks are refused
 * on the far side anyway, so following one here would only turn a refusal into
 * a surprise.
 */

/** Directory or file names dropped unconditionally, at any depth. */
export const HARD_EXCLUDED_NAMES = [".git", "node_modules", "dist"] as const;

/** `.env`, `.env.local`, `.env.production` — anything in that family. */
export const ENV_FILE_PATTERN = /^\.env(\..*)?$/;

/** The control plane's own cap (`MAX_TARBALL_BYTES`), refused here first. */
export const MAX_TARBALL_BYTES = 64 * 1024 * 1024;

/** A file bigger than this is almost certainly not source; it is reported. */
const LARGE_FILE_BYTES = 2 * 1024 * 1024;

export class PublishTarballError extends Error {
  readonly code: "too_large" | "empty";
  /** The biggest files found, for a message the user can act on. */
  readonly largest: PackedEntry[];

  constructor(
    code: PublishTarballError["code"],
    message: string,
    largest: PackedEntry[] = [],
  ) {
    super(message);
    this.name = "PublishTarballError";
    this.code = code;
    this.largest = largest;
  }
}

export interface PackedEntry {
  /** Path relative to the scaffold root, "/"-separated. */
  path: string;
  bytes: number;
}

export interface BuildTarballResult {
  /** The gzipped archive. */
  archive: Buffer;
  /** Every file in it, sorted by path. */
  entries: PackedEntry[];
  /** Sum of the uncompressed file sizes. */
  uncompressedBytes: number;
}

/** True for anything the hard excludes drop, by BASENAME, at any depth. */
export function isHardExcluded(name: string): boolean {
  const names: readonly string[] = HARD_EXCLUDED_NAMES;
  return names.includes(name) || ENV_FILE_PATTERN.test(name);
}

/**
 * Every file that belongs in the archive, relative to `root`, sorted.
 *
 * An IGNORED DIRECTORY IS NOT DESCENDED INTO — git's rule, and the reason a
 * `!` inside an ignored directory cannot resurrect anything. It is also what
 * keeps this walk proportional to what ships rather than to what exists.
 */
export function collectFiles(root: string): PackedEntry[] {
  const entries: PackedEntry[] = [];

  const walk = (relDir: string, scopes: readonly IgnoreScope[]): void => {
    const absDir = relDir === "" ? root : join(root, relDir);

    const ignoreFile = join(absDir, ".gitignore");
    let nextScopes = scopes;
    if (existsSync(ignoreFile)) {
      try {
        nextScopes = [
          ...scopes,
          {
            base: relDir,
            patterns: parseIgnoreFile(readFileSync(ignoreFile, "utf8")),
          },
        ];
      } catch {
        // An unreadable .gitignore ignores nothing rather than failing a
        // publish — the hard excludes are what actually must hold.
      }
    }

    let dirents: Dirent[];
    try {
      dirents = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const dirent of dirents) {
      const name = dirent.name;
      // FIRST, unconditionally, before any pattern is consulted.
      if (isHardExcluded(name)) continue;

      const rel = relDir === "" ? name : `${relDir}/${name}`;

      // Symlinks are not followed: the far side refuses link entries, and
      // dereferencing here would silently ship whatever they point at.
      if (dirent.isSymbolicLink()) continue;

      if (dirent.isDirectory()) {
        if (isIgnored(rel, true, nextScopes)) continue;
        walk(rel, nextScopes);
        continue;
      }

      if (!dirent.isFile()) continue;
      if (isIgnored(rel, false, nextScopes)) continue;

      let size: number;
      try {
        size = statSync(join(root, rel)).size;
      } catch {
        continue;
      }
      entries.push({ path: rel, bytes: size });
    }
  };

  walk("", []);
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return entries;
}

const BLOCK = 512;

function octal(value: number, width: number): string {
  // width-1 digits then a NUL, which is what ustar readers expect.
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

function writeAscii(
  block: Buffer,
  text: string,
  offset: number,
  length: number,
): void {
  block.write(text, offset, length, "utf8");
}

/**
 * One ustar header block.
 *
 * The checksum is computed with the checksum field itself read as eight
 * spaces — that is the format's definition, not a quirk, and getting it wrong
 * produces an archive every reader rejects.
 */
function header(input: {
  name: string;
  prefix: string;
  size: number;
  mode: number;
  typeflag: string;
}): Buffer {
  const block = Buffer.alloc(BLOCK);
  writeAscii(block, input.name, 0, 100);
  writeAscii(block, octal(input.mode & 0o7777, 8), 100, 8);
  writeAscii(block, octal(0, 8), 108, 8); // uid — never carried over
  writeAscii(block, octal(0, 8), 116, 8); // gid — never carried over
  writeAscii(block, octal(input.size, 12), 124, 12);
  // A fixed mtime: the archive is a function of the tree's CONTENT, so two
  // publishes of an unchanged tree are byte-identical.
  writeAscii(block, octal(0, 12), 136, 12);
  writeAscii(block, "        ", 148, 8); // checksum placeholder
  writeAscii(block, input.typeflag, 156, 1);
  writeAscii(block, "ustar\0", 257, 6);
  writeAscii(block, "00", 263, 2);
  writeAscii(block, input.prefix, 345, 155);

  let sum = 0;
  for (const byte of block) sum += byte;
  writeAscii(block, `${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return block;
}

function padding(size: number): Buffer {
  const remainder = size % BLOCK;
  return remainder === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - remainder);
}

/**
 * Split a path across ustar's 100-byte `name` and 155-byte `prefix` fields.
 * Returns null when it will not fit either way — the caller then emits a GNU
 * long-name record, which the control plane's reader understands.
 */
function splitName(path: string): { name: string; prefix: string } | null {
  const bytes = Buffer.byteLength(path);
  if (bytes <= 100) return { name: path, prefix: "" };

  for (let cut = path.length - 1; cut > 0; cut -= 1) {
    if (path[cut] !== "/") continue;
    const prefix = path.slice(0, cut);
    const name = path.slice(cut + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }
  return null;
}

/** The blocks for one file entry, long-name record included when needed. */
function fileEntry(path: string, data: Buffer, mode: number): Buffer[] {
  const blocks: Buffer[] = [];
  const split = splitName(path);

  if (!split) {
    // GNU long name: an `L` entry whose DATA is the real path, naming the
    // entry that follows it.
    const nameBytes = Buffer.from(`${path}\0`, "utf8");
    blocks.push(
      header({
        name: "././@LongLink",
        prefix: "",
        size: nameBytes.length,
        mode: 0o644,
        typeflag: "L",
      }),
      nameBytes,
      padding(nameBytes.length),
    );
  }

  blocks.push(
    header({
      name: split ? split.name : path.slice(0, 100),
      prefix: split ? split.prefix : "",
      size: data.length,
      mode,
      typeflag: "0",
    }),
    data,
    padding(data.length),
  );
  return blocks;
}

export interface BuildTarballOptions {
  /** Refuse past this many uncompressed bytes. Defaults to the cloud's cap. */
  maxBytes?: number;
}

/**
 * Pack `root` into a gzipped tarball, applying the hard excludes and the
 * repository's `.gitignore` files.
 */
export function buildPublishTarball(
  root: string,
  options: BuildTarballOptions = {},
): BuildTarballResult {
  const entries = collectFiles(root);
  if (entries.length === 0) {
    throw new PublishTarballError(
      "empty",
      "Nothing to publish: every file under this directory is excluded.",
    );
  }

  const total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  const cap = options.maxBytes ?? MAX_TARBALL_BYTES;
  if (total > cap) {
    const largest = [...entries]
      .sort((a, b) => b.bytes - a.bytes)
      .filter((entry) => entry.bytes >= LARGE_FILE_BYTES)
      .slice(0, 5);
    throw new PublishTarballError(
      "too_large",
      `This app is ${(total / (1024 * 1024)).toFixed(1)}MB of source, over the ${cap / (1024 * 1024)}MB publish limit.`,
      largest,
    );
  }

  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const absolute = join(root, entry.path);
    const data = readFileSync(absolute);
    // The only mode bit that travels: executable. The far side strips
    // setuid/setgid/sticky anyway; not sending them is the cheaper half.
    const executable = (statSync(absolute).mode & 0o111) !== 0;
    blocks.push(...fileEntry(entry.path, data, executable ? 0o755 : 0o644));
  }
  // Two zero blocks terminate a tar archive.
  blocks.push(Buffer.alloc(BLOCK * 2));

  return {
    archive: gzipSync(Buffer.concat(blocks), { level: 9 }),
    entries,
    uncompressedBytes: total,
  };
}
