import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { extractTarball, resolveAppRoot, TarballError } from "../lib/tarball";

/**
 * The unpacker, against REAL archives built byte-by-byte in this file.
 *
 * A publish tarball is the one thing in the pipeline that is entirely under a
 * stranger's control, so its parser is tested the only way that proves
 * anything: hostile archives, constructed here, extracted for real onto a temp
 * directory, with the filesystem checked afterwards. Every refusal case asserts
 * BOTH the throw and that nothing landed outside the destination.
 */

const BLOCK = 512;

interface Entry {
  name: string;
  content?: string;
  /** ustar typeflag: "0" file, "5" dir, "2" symlink, "L" GNU long name, … */
  type?: string;
  mode?: number;
  linkname?: string;
}

/** One ustar entry: a 512-byte header plus block-padded data. */
function tarEntry(entry: Entry): Buffer {
  const header = Buffer.alloc(BLOCK, 0);
  const data = Buffer.from(entry.content ?? "", "utf8");
  header.write(entry.name, 0, 100, "utf8");
  header.write(
    `${(entry.mode ?? 0o644).toString(8).padStart(7, "0")}\0`,
    100,
    8,
  );
  header.write("0000000\0", 108, 8);
  header.write("0000000\0", 116, 8);
  header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, 12);
  header.write("00000000000\0", 136, 12);
  // Checksum is computed over the header with this field read as spaces.
  header.write("        ", 148, 8);
  header.write(entry.type ?? "0", 156, 1);
  if (entry.linkname) header.write(entry.linkname, 157, 100, "utf8");
  header.write("ustar\0", 257, 6);
  header.write("00", 263, 2);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);

  const padding = Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK, 0);
  return Buffer.concat([header, data, padding]);
}

/** A gzipped tar of `entries`, terminated by the two empty blocks tar expects. */
function makeTarGz(entries: Entry[]): Buffer {
  return gzipSync(
    Buffer.concat([...entries.map(tarEntry), Buffer.alloc(BLOCK * 2, 0)]),
  );
}

function workspace(): { archive: string; dest: string } {
  const root = mkdtempSync(join(tmpdir(), "hogsend-tar-"));
  return { archive: join(root, "app.tar.gz"), dest: join(root, "out") };
}

function write(archive: string, bytes: Buffer): void {
  writeFileSync(archive, bytes);
}

describe("extractTarball", () => {
  it("extracts files and directories under the destination", async () => {
    const { archive, dest } = workspace();
    write(
      archive,
      makeTarGz([
        { name: "app/", type: "5" },
        { name: "app/package.json", content: '{"name":"acme"}' },
        { name: "app/src/index.ts", content: "export const x = 1;\n" },
      ]),
    );

    const result = await extractTarball({
      archivePath: archive,
      destDir: dest,
    });

    expect(result.files).toBe(2);
    expect(readFileSync(join(dest, "app/package.json"), "utf8")).toBe(
      '{"name":"acme"}',
    );
    expect(readFileSync(join(dest, "app/src/index.ts"), "utf8")).toBe(
      "export const x = 1;\n",
    );
  });

  it("refuses an entry that escapes the destination with ..", async () => {
    const { archive, dest } = workspace();
    write(
      archive,
      makeTarGz([
        { name: "app/package.json", content: "{}" },
        { name: "../escaped.txt", content: "pwned" },
      ]),
    );

    await expect(
      extractTarball({ archivePath: archive, destDir: dest }),
    ).rejects.toThrow(TarballError);
    // And nothing from the archive is left behind above the destination.
    const siblings = await readdir(join(dest, ".."));
    expect(siblings).not.toContain("escaped.txt");
  });

  it("refuses an absolute entry path", async () => {
    const { archive, dest } = workspace();
    write(archive, makeTarGz([{ name: "/etc/passwd", content: "pwned" }]));

    await expect(
      extractTarball({ archivePath: archive, destDir: dest }),
    ).rejects.toThrow(/absolute/i);
  });

  it("refuses a symlink entry", async () => {
    const { archive, dest } = workspace();
    write(
      archive,
      makeTarGz([{ name: "app/link", type: "2", linkname: "/etc/passwd" }]),
    );

    await expect(
      extractTarball({ archivePath: archive, destDir: dest }),
    ).rejects.toThrow(/link/i);
  });

  it("refuses a traversal hidden in a GNU long name", async () => {
    const { archive, dest } = workspace();
    const long = `${"a/".repeat(60)}../../escaped.txt`;
    write(
      archive,
      makeTarGz([
        { name: "././@LongLink", type: "L", content: `${long}\0` },
        { name: "app/short.txt", content: "pwned" },
      ]),
    );

    await expect(
      extractTarball({ archivePath: archive, destDir: dest }),
    ).rejects.toThrow(TarballError);
  });

  it("caps the extracted size", async () => {
    const { archive, dest } = workspace();
    write(
      archive,
      makeTarGz([{ name: "app/big.bin", content: "x".repeat(4096) }]),
    );

    await expect(
      extractTarball({ archivePath: archive, destDir: dest, maxBytes: 1024 }),
    ).rejects.toMatchObject({ code: "too_large" });
  });

  it("caps the entry count", async () => {
    const { archive, dest } = workspace();
    write(
      archive,
      makeTarGz(
        Array.from({ length: 5 }, (_, index) => ({
          name: `app/file-${index}.txt`,
          content: "x",
        })),
      ),
    );

    await expect(
      extractTarball({ archivePath: archive, destDir: dest, maxEntries: 3 }),
    ).rejects.toMatchObject({ code: "too_many_entries" });
  });

  it("caps the entry count for DIRECTORIES too", async () => {
    // A directory entry is a header with no data, so neither byte ceiling ever
    // fires on it and a run of them gzips at roughly 1000:1 — an archive well
    // inside the upload cap can ask for millions of mkdirs on a host every
    // tenant shares. The entry cap is the only thing standing there.
    const { archive, dest } = workspace();
    write(
      archive,
      makeTarGz(
        Array.from({ length: 20 }, (_, index) => ({
          name: `app/dir-${index}/`,
          type: "5",
        })),
      ),
    );

    await expect(
      extractTarball({ archivePath: archive, destDir: dest, maxEntries: 5 }),
    ).rejects.toMatchObject({ code: "too_many_entries" });

    const written = await readdir(join(dest, "app"));
    expect(written.length).toBeLessThanOrEqual(5);
  });

  it("never writes a setuid bit, whatever the archive asked for", async () => {
    const { archive, dest } = workspace();
    write(
      archive,
      makeTarGz([{ name: "app/run.sh", content: "#!/bin/sh\n", mode: 0o4755 }]),
    );

    await extractTarball({ archivePath: archive, destDir: dest });
    const { statSync } = await import("node:fs");
    const mode = statSync(join(dest, "app/run.sh")).mode & 0o7777;
    expect(mode & 0o4000).toBe(0);
    // The executable bit survives — preflight.sh has to stay runnable.
    expect(mode & 0o111).not.toBe(0);
  });
});

describe("resolveAppRoot", () => {
  it("descends through a single wrapping directory", async () => {
    const { archive, dest } = workspace();
    write(
      archive,
      makeTarGz([
        { name: "acme/package.json", content: "{}" },
        { name: "acme/src/index.ts", content: "" },
      ]),
    );
    await extractTarball({ archivePath: archive, destDir: dest });

    expect(await resolveAppRoot(dest)).toBe(join(dest, "acme"));
  });

  it("stays put when the archive is already rooted at the app", async () => {
    const { archive, dest } = workspace();
    write(
      archive,
      makeTarGz([
        { name: "package.json", content: "{}" },
        { name: "src/index.ts", content: "" },
      ]),
    );
    await extractTarball({ archivePath: archive, destDir: dest });

    expect(await resolveAppRoot(dest)).toBe(dest);
  });
});
