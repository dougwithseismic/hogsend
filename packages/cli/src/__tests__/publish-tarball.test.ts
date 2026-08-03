import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isIgnored, parseIgnoreFile } from "../lib/gitignore.js";
import {
  buildPublishTarball,
  collectFiles,
  isHardExcluded,
  PublishTarballError,
} from "../lib/publish-tarball.js";

/**
 * The tarball is the one artifact this CLI sends off the machine, so the case
 * that matters most is the POISONED FIXTURE below: a repository containing
 * every secret-bearing and junk path a scaffold can accumulate, including a
 * `.gitignore` that actively tries to RE-INCLUDE `.env` with a negation. The
 * archive must contain none of it, and the assertions read the produced bytes
 * back rather than the walker's own bookkeeping — a hard exclusion that held in
 * `collectFiles` but leaked in the packer would be a real leak.
 *
 * The tar is parsed here with a tiny independent reader rather than by
 * importing the control plane's unpacker: two copies of the format that agree
 * is evidence; one copy checking itself is not.
 */

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hogsend-pack-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(relPath: string, contents = "x"): void {
  const file = join(root, relPath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents);
}

/** A minimal ustar reader: enough to name every entry in an archive. */
function readTar(
  gzipped: Buffer,
): { path: string; size: number; body: string }[] {
  const buffer = gunzipSync(gzipped);
  const entries: { path: string; size: number; body: string }[] = [];
  let offset = 0;
  let longName: string | null = null;

  while (offset + 512 <= buffer.length) {
    const block = buffer.subarray(offset, offset + 512);
    offset += 512;
    if (block.every((byte) => byte === 0)) break;

    const read = (start: number, length: number): string => {
      const raw = block.subarray(start, start + length);
      const end = raw.indexOf(0);
      return raw.toString("utf8", 0, end === -1 ? raw.length : end);
    };

    const name = read(0, 100);
    const prefix = read(345, 155);
    const size = Number.parseInt(read(124, 12).trim() || "0", 8);
    const type = String.fromCharCode(block[156] ?? 0) || "0";

    // The checksum must validate, computed with the field read as spaces.
    const stated = Number.parseInt(read(148, 8).trim() || "0", 8);
    let sum = 0;
    for (let index = 0; index < 512; index += 1) {
      sum += index >= 148 && index < 156 ? 0x20 : (block[index] as number);
    }
    expect(sum).toBe(stated);

    const body = buffer.subarray(offset, offset + size).toString("utf8");
    offset += Math.ceil(size / 512) * 512;

    if (type === "L") {
      longName = body.replace(/\0+$/, "");
      continue;
    }
    const path = longName ?? (prefix ? `${prefix}/${name}` : name);
    longName = null;
    entries.push({ path, size, body });
  }

  return entries;
}

/**
 * A repository that has everything wrong with it: secrets, build output,
 * dependencies, history — and a `.gitignore` that tries to un-ignore the
 * secrets.
 */
function poison(): void {
  // Real source, which must survive.
  write("package.json", JSON.stringify({ name: "acme-lifecycle" }));
  write("src/index.ts", "export const app = 1;\n");
  write("src/journeys/welcome.ts", "export const welcome = 1;\n");
  write("README.md", "# acme\n");

  // Secrets, at the root and nested.
  write(".env", "RESEND_API_KEY=re_live_do_not_ship\n");
  write(".env.local", "DATABASE_URL=postgres://secret\n");
  write(".env.production", "BETTER_AUTH_SECRET=hunter2\n");
  write("apps/api/.env", "NESTED_SECRET=1\n");

  // Junk.
  write("node_modules/left-pad/index.js", "module.exports = 1;\n");
  write("apps/api/node_modules/deep/index.js", "module.exports = 2;\n");
  write("dist/index.js", "console.log(1);\n");
  write("apps/api/dist/index.js", "console.log(2);\n");
  write(".git/config", "[core]\n");
  write(".git/objects/ab/cdef", "binary\n");

  // The attack this exists to defeat: a repository asking for its secrets to
  // be included.
  write(
    ".gitignore",
    ["*.log", "coverage/", "!.env", "!node_modules", "!dist", ""].join("\n"),
  );
  write("debug.log", "noise\n");
  write("coverage/lcov.info", "noise\n");
}

describe("publish tarball — hard excludes", () => {
  it("never ships .env*, node_modules, dist or .git — even when .gitignore un-ignores them", () => {
    poison();

    const { archive, entries } = buildPublishTarball(root);
    const packed = readTar(archive).map((entry) => entry.path);

    // Everything the walker claimed, and everything the ARCHIVE actually has.
    for (const paths of [entries.map((entry) => entry.path), packed]) {
      expect(paths).toContain("package.json");
      expect(paths).toContain("src/index.ts");
      expect(paths).toContain("src/journeys/welcome.ts");
      expect(paths).toContain("README.md");

      for (const forbidden of [
        ".env",
        ".env.local",
        ".env.production",
        "apps/api/.env",
        "node_modules/left-pad/index.js",
        "apps/api/node_modules/deep/index.js",
        "dist/index.js",
        "apps/api/dist/index.js",
        ".git/config",
        ".git/objects/ab/cdef",
      ]) {
        expect(paths).not.toContain(forbidden);
      }

      // The ordinary .gitignore rules still apply.
      expect(paths).not.toContain("debug.log");
      expect(paths).not.toContain("coverage/lcov.info");
    }

    // And nothing shaped like a secret survives as BYTES, whatever it is named.
    const raw = gunzipSync(archive).toString("utf8");
    expect(raw).not.toContain("re_live_do_not_ship");
    expect(raw).not.toContain("hunter2");
    expect(raw).not.toContain("postgres://secret");
  });

  it("classifies the excluded basenames directly", () => {
    for (const name of [
      ".git",
      "node_modules",
      "dist",
      ".env",
      ".env.local",
      ".env.production.local",
    ]) {
      expect(isHardExcluded(name)).toBe(true);
    }
    for (const name of ["src", "package.json", "environment.ts", ".envrc"]) {
      expect(isHardExcluded(name)).toBe(false);
    }
  });
});

describe("publish tarball — archive shape", () => {
  it("round-trips file contents and is byte-identical for an unchanged tree", () => {
    write("package.json", JSON.stringify({ name: "acme" }));
    write("src/a.ts", "export const a = 1;\n");
    write("src/b.ts", "export const b = 2;\n");

    const first = buildPublishTarball(root);
    const second = buildPublishTarball(root);

    // Deterministic: a fixed mtime and a sorted walk mean an unchanged tree
    // produces the same bytes, which is what makes "did anything change"
    // answerable at all.
    expect(second.archive.equals(first.archive)).toBe(true);

    const packed = readTar(first.archive);
    expect(packed.map((entry) => entry.path)).toEqual([
      "package.json",
      "src/a.ts",
      "src/b.ts",
    ]);
    expect(packed.find((entry) => entry.path === "src/b.ts")?.body).toBe(
      "export const b = 2;\n",
    );
  });

  it("carries a path too long for the 100-byte name field", () => {
    const deep = `${"nested-directory-with-a-long-name/".repeat(4)}some-file-with-a-very-long-name.ts`;
    write("package.json", "{}");
    write(deep, "export const deep = 1;\n");

    const packed = readTar(buildPublishTarball(root).archive);
    expect(packed.map((entry) => entry.path)).toContain(deep);
  });

  it("refuses an app over the size cap, naming the biggest files", () => {
    write("package.json", "{}");
    write("assets/huge.bin", "0".repeat(3 * 1024 * 1024));

    try {
      buildPublishTarball(root, { maxBytes: 1024 * 1024 });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(PublishTarballError);
      const refusal = error as PublishTarballError;
      expect(refusal.code).toBe("too_large");
      expect(refusal.largest[0]?.path).toBe("assets/huge.bin");
    }
  });

  it("refuses an empty result rather than uploading an archive of nothing", () => {
    write(".env", "SECRET=1\n");
    write("node_modules/x/index.js", "1\n");

    expect(() => buildPublishTarball(root)).toThrow(PublishTarballError);
  });
});

describe("gitignore subset", () => {
  it("honours negation, anchoring, directory-only and depth", () => {
    const scopes = [
      {
        base: "",
        patterns: parseIgnoreFile(
          [
            "# a comment",
            "*.log",
            "!keep.log",
            "/build",
            "tmp/",
            "**/generated",
            "docs/*.pdf",
          ].join("\n"),
        ),
      },
    ];

    expect(isIgnored("debug.log", false, scopes)).toBe(true);
    // Last matching pattern wins, which is git's rule.
    expect(isIgnored("keep.log", false, scopes)).toBe(false);
    // An anchored pattern matches at the root only.
    expect(isIgnored("build", true, scopes)).toBe(true);
    expect(isIgnored("apps/build", true, scopes)).toBe(false);
    // A directory-only pattern never matches a file of the same name.
    expect(isIgnored("tmp", true, scopes)).toBe(true);
    expect(isIgnored("tmp", false, scopes)).toBe(false);
    // An unanchored name matches at any depth.
    expect(isIgnored("src/generated", true, scopes)).toBe(true);
    expect(isIgnored("docs/spec.pdf", false, scopes)).toBe(true);
    expect(isIgnored("docs/deep/spec.pdf", false, scopes)).toBe(false);
    expect(isIgnored("src/index.ts", false, scopes)).toBe(false);
  });

  it("lets a nested .gitignore override the root's, and skips ignored directories whole", () => {
    write("package.json", "{}");
    write(".gitignore", "secrets/\n*.tmp\n");
    write("secrets/keys.json", "{}");
    // Git does not descend into an ignored directory, so this negation cannot
    // resurrect the file above it.
    write("secrets/.gitignore", "!keys.json\n");
    write("apps/.gitignore", "!*.tmp\n");
    write("apps/scratch.tmp", "kept by the nested rule\n");
    write("root.tmp", "dropped by the root rule\n");

    const paths = collectFiles(root).map((entry) => entry.path);
    expect(paths).toContain("package.json");
    expect(paths).toContain("apps/scratch.tmp");
    expect(paths).not.toContain("root.tmp");
    expect(paths).not.toContain("secrets/keys.json");
  });
});
