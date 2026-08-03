import { createReadStream } from "node:fs";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { createGunzip } from "node:zlib";

/**
 * The publish tarball unpacker.
 *
 * A publish artifact is the ONE input to this pipeline that a stranger controls
 * end to end, so the archive is treated as hostile and this module is written
 * to refuse rather than to be lenient. Everything here is a deliberate
 * narrowing of what tar can express:
 *
 *  - **No entry may leave the destination.** Absolute paths, drive letters and
 *    any `..` component are refused outright, and the resolved path is checked
 *    against the destination root a second time. Both checks apply to the name
 *    a GNU long-name or pax header supplied, not just to the 100-byte field —
 *    that is the exact place a lenient parser gets walked out of its root.
 *  - **No links, no devices.** Symlinks and hard links are the other traversal
 *    vector (a link to `/` followed by a write through it), and a build context
 *    has no legitimate use for a device node or a FIFO. Every non-file,
 *    non-directory entry is refused.
 *  - **No ownership, no elevation.** uid/gid/uname/gname are IGNORED — files
 *    land owned by whoever is running the build — and setuid/setgid/sticky bits
 *    are stripped. The only mode bit carried over is "executable", because
 *    `scripts/preflight.sh` has to stay runnable.
 *  - **Bounded.** Total extracted bytes, per-entry bytes and entry count all
 *    have ceilings, so a zip bomb fails the build instead of the host.
 *
 * A custom reader rather than a dependency: the rules above ARE the module, the
 * subset of tar a scaffold needs is small, and a parser we can read is worth
 * more here than one we can only configure.
 */

const BLOCK = 512;

/** 256MiB of unpacked app. A scaffold is a few MB; this is a wall, not a fit. */
export const DEFAULT_MAX_EXTRACTED_BYTES = 256 * 1024 * 1024;
/** No single file in a source tree is 64MB. Anything that big is not source. */
export const DEFAULT_MAX_ENTRY_BYTES = 64 * 1024 * 1024;
/** A generous ceiling on file count — a scaffold has a few hundred. */
export const DEFAULT_MAX_ENTRIES = 20_000;

/** Every refusal this module makes. `code` is stable; `message` is for humans. */
export class TarballError extends Error {
  readonly code:
    | "unsafe_path"
    | "unsupported_entry"
    | "too_large"
    | "too_many_entries"
    | "malformed";

  constructor(code: TarballError["code"], message: string) {
    super(message);
    this.name = "TarballError";
    this.code = code;
  }
}

export interface ExtractTarballInput {
  archivePath: string;
  destDir: string;
  maxBytes?: number;
  maxEntryBytes?: number;
  maxEntries?: number;
}

export interface ExtractTarballResult {
  files: number;
  directories: number;
  bytes: number;
}

interface TarHeader {
  name: string;
  size: number;
  type: string;
  mode: number;
}

function readString(block: Buffer, offset: number, length: number): string {
  const raw = block.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw.toString("utf8", 0, end === -1 ? raw.length : end);
}

function readOctal(block: Buffer, offset: number, length: number): number {
  const text = readString(block, offset, length).trim();
  if (text.length === 0) return 0;
  const value = Number.parseInt(text, 8);
  return Number.isFinite(value) ? value : 0;
}

function isZeroBlock(block: Buffer): boolean {
  for (const byte of block) if (byte !== 0) return false;
  return true;
}

function parseHeader(block: Buffer): TarHeader | null {
  if (isZeroBlock(block)) return null;
  const name = readString(block, 0, 100);
  const prefix = readString(block, 345, 155);
  const typeByte = block[156] ?? 0;
  const type = typeByte === 0 ? "0" : String.fromCharCode(typeByte);
  return {
    name: prefix ? `${prefix}/${name}` : name,
    mode: readOctal(block, 100, 8),
    size: readOctal(block, 124, 12),
    type,
  };
}

/**
 * The containment check. Applied to whatever name finally won (short field,
 * GNU long name, or pax `path`), never to only one of them.
 */
function safeTarget(root: string, entryName: string): string {
  const normalized = entryName.replace(/\\/g, "/").trim();
  if (normalized.length === 0) {
    throw new TarballError("unsafe_path", "the archive contains an empty path");
  }
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    throw new TarballError(
      "unsafe_path",
      `the archive contains an absolute path: "${entryName}"`,
    );
  }
  const parts = normalized
    .split("/")
    .filter((part) => part.length > 0 && part !== ".");
  if (parts.some((part) => part === "..")) {
    throw new TarballError(
      "unsafe_path",
      `the archive contains a path that escapes the destination: "${entryName}"`,
    );
  }
  if (parts.length === 0) {
    throw new TarballError(
      "unsafe_path",
      `the archive contains a path that names no file: "${entryName}"`,
    );
  }
  const target = resolve(join(root, parts.join("/")));
  // Belt to the component braces: whatever the parts were, the result must
  // still sit under the root.
  if (target !== root && !target.startsWith(root + sep)) {
    throw new TarballError(
      "unsafe_path",
      `the archive contains a path that escapes the destination: "${entryName}"`,
    );
  }
  return target;
}

/**
 * Mode for an extracted file: the executable bit if the archive had one, and
 * nothing else. setuid/setgid/sticky are never carried over.
 */
function safeMode(mode: number): number {
  return (mode & 0o111) === 0 ? 0o644 : 0o755;
}

/** The `path=` value out of a pax extended header record set. */
function paxPath(data: Buffer): string | null {
  let offset = 0;
  const text = data.toString("utf8");
  while (offset < text.length) {
    const space = text.indexOf(" ", offset);
    if (space === -1) break;
    const length = Number.parseInt(text.slice(offset, space), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = text.slice(space + 1, offset + length).replace(/\n$/, "");
    const eq = record.indexOf("=");
    if (eq !== -1 && record.slice(0, eq) === "path")
      return record.slice(eq + 1);
    offset += length;
  }
  return null;
}

/**
 * Unpack `archivePath` into `destDir`, refusing anything the doc-comment above
 * says is refused. The destination is created; it is NOT emptied first, so the
 * caller owns giving each build a fresh directory.
 */
export async function extractTarball(
  input: ExtractTarballInput,
): Promise<ExtractTarballResult> {
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_EXTRACTED_BYTES;
  const maxEntryBytes = Math.min(
    input.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES,
    maxBytes,
  );
  const maxEntries = input.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const root = resolve(input.destDir);
  await mkdir(root, { recursive: true });

  const gunzip = createGunzip();
  const source = createReadStream(input.archivePath);
  source.on("error", (error) => gunzip.destroy(error));
  source.pipe(gunzip);

  let pending: Buffer = Buffer.alloc(0);

  /**
   * The reader's cursor, held in an OBJECT rather than in `let`s: every field
   * is written both by the closures below and by the chunk loop, and TypeScript
   * narrows a `let` from its initializer alone (assignments inside a closure are
   * invisible to control-flow analysis), which would make `state.header` read as
   * `never` at the very place its size is needed.
   */
  const state: {
    /** Bytes still to consume for the entry currently being read. */
    remaining: number;
    data: Buffer[];
    header: TarHeader | null;
    /** A name from a GNU `L` / pax `x` record, for the NEXT entry only. */
    overrideName: string | null;
  } = { remaining: 0, data: [], header: null, overrideName: null };

  const result: ExtractTarballResult = { files: 0, directories: 0, bytes: 0 };

  const beginEntry = (next: TarHeader): void => {
    if (next.size > maxEntryBytes) {
      throw new TarballError(
        "too_large",
        `"${next.name}" is larger than the ${maxEntryBytes}-byte per-file limit`,
      );
    }
    result.bytes += next.size;
    if (result.bytes > maxBytes) {
      throw new TarballError(
        "too_large",
        `the archive unpacks to more than the ${maxBytes}-byte size limit`,
      );
    }
    state.header = next;
    state.remaining = next.size;
    state.data = [];
  };

  const finishEntry = async (): Promise<void> => {
    const current = state.header;
    if (!current) return;
    const data = Buffer.concat(state.data);
    state.header = null;
    state.data = [];

    // Metadata entries name the NEXT entry; they are never written out.
    if (current.type === "L") {
      state.overrideName = data.toString("utf8").replace(/\0+$/, "");
      return;
    }
    if (current.type === "K") return;
    if (current.type === "x") {
      state.overrideName = paxPath(data) ?? state.overrideName;
      return;
    }
    if (current.type === "g") return;

    const name = state.overrideName ?? current.name;
    state.overrideName = null;

    if (current.type === "1" || current.type === "2") {
      throw new TarballError(
        "unsupported_entry",
        `the archive contains a link entry ("${name}"); links are refused in a build context`,
      );
    }
    if (!["0", "5", "7"].includes(current.type)) {
      throw new TarballError(
        "unsupported_entry",
        `the archive contains an unsupported entry type "${current.type}" ("${name}")`,
      );
    }

    const target = safeTarget(root, name);

    // The count is checked BEFORE the type dispatch, so it covers directories
    // as well as files. A directory entry is a 512-byte header with no data:
    // it never trips the byte ceilings, and gzip packs a run of them at
    // ~1000:1, so an archive well inside the upload cap can ask for tens of
    // millions of `mkdir`s. Unbounded inode creation on a host shared by every
    // tenant is the same denial of service a zip bomb is.
    if (result.files + result.directories >= maxEntries) {
      throw new TarballError(
        "too_many_entries",
        `the archive contains more than the ${maxEntries}-entry limit`,
      );
    }

    if (current.type === "5") {
      await mkdir(target, { recursive: true, mode: 0o755 });
      result.directories += 1;
      return;
    }

    await mkdir(dirname(target), { recursive: true, mode: 0o755 });
    await writeFile(target, data, { mode: safeMode(current.mode) });
    result.files += 1;
  };

  for await (const chunk of gunzip) {
    const block = chunk as Buffer;
    pending = pending.length === 0 ? block : Buffer.concat([pending, block]);

    for (;;) {
      if (state.remaining > 0) {
        const take = Math.min(state.remaining, pending.length);
        if (take === 0) break;
        state.data.push(pending.subarray(0, take));
        pending = pending.subarray(take);
        state.remaining -= take;
        continue;
      }
      if (state.header) {
        // The data is complete; skip the block padding before the next header.
        const padding = (BLOCK - (state.header.size % BLOCK)) % BLOCK;
        if (pending.length < padding) break;
        pending = pending.subarray(padding);
        await finishEntry();
        continue;
      }
      if (pending.length < BLOCK) break;
      const headerBlock = pending.subarray(0, BLOCK);
      pending = pending.subarray(BLOCK);
      const next = parseHeader(headerBlock);
      // Two zero blocks end the archive; one is enough to stop reading headers.
      if (!next) continue;
      beginEntry(next);
      if (next.size === 0) {
        // Nothing to read: the entry is complete already.
        await finishEntry();
      }
    }
  }

  if (state.remaining > 0) {
    throw new TarballError(
      "malformed",
      "the archive ended in the middle of a file",
    );
  }
  if (state.header) await finishEntry();
  if (result.files === 0 && result.directories === 0) {
    throw new TarballError("malformed", "the archive contains no entries");
  }
  return result;
}

/**
 * Where the app actually lives inside an unpacked archive.
 *
 * `hogsend publish` may tar the app's contents or the directory containing
 * them, and both are legitimate. The rule is the one a human would apply: the
 * app root is where `package.json` is, so descend through a single wrapping
 * directory when the top level has none.
 */
export async function resolveAppRoot(dir: string): Promise<string> {
  const root = resolve(dir);
  const entries = await readdir(root, { withFileTypes: true });
  if (
    entries.some((entry) => entry.isFile() && entry.name === "package.json")
  ) {
    return root;
  }
  const directories = entries.filter((entry) => entry.isDirectory());
  if (directories.length !== 1 || !directories[0]) return root;

  const nested = join(root, directories[0].name);
  const stats = await stat(join(nested, "package.json")).catch(() => null);
  return stats?.isFile() ? nested : root;
}
