import { describe, expect, it } from "vitest";
import { mergeEnv } from "../lib/env-file.js";

/**
 * The `.env` merge, which is the destructive half of `hogsend env pull`.
 *
 * Every case here is a way a naive implementation loses someone's work: a
 * parse-and-reprint that drops comments, an append that shadows the value
 * already in force, a blind overwrite of a key someone is actively using, or a
 * "conflict" reported between `KEY=x` and `KEY="x"`.
 */

const URL_KEY = "HOGSEND_API_URL";
const KEY_KEY = "HOGSEND_API_KEY";
const updates = {
  [URL_KEY]: "https://tenant.example.test",
  [KEY_KEY]: "hsk_live_1",
};

describe("mergeEnv", () => {
  it("creates the file's whole content when there was none", () => {
    const merged = mergeEnv("", updates, { comment: "Hogsend" });
    expect(merged.changed).toBe(true);
    expect(merged.conflicts).toEqual([]);
    expect(merged.content).toBe(
      "# Hogsend\nHOGSEND_API_URL=https://tenant.example.test\nHOGSEND_API_KEY=hsk_live_1\n",
    );
  });

  it("leaves every unrelated variable, comment and blank line untouched", () => {
    const before = [
      "# my app",
      "DATABASE_URL=postgres://localhost/app",
      "",
      "# email",
      'RESEND_API_KEY="re_123"   # rotate me',
      "",
    ].join("\n");

    const merged = mergeEnv(before, updates);

    // Not "contains": the original text must survive as a PREFIX, byte for
    // byte, which is what makes the diff reviewable.
    expect(merged.content.startsWith(before)).toBe(true);
    expect(merged.content).toContain("HOGSEND_API_KEY=hsk_live_1");
    expect(merged.results.every((row) => row.outcome === "added")).toBe(true);
  });

  it("edits in place rather than appending a second, shadowing assignment", () => {
    const before = ["HOGSEND_API_URL=", "HOGSEND_API_KEY=", "OTHER=keep"].join(
      "\n",
    );

    const merged = mergeEnv(before, updates);
    expect(merged.content).toBe(
      [
        "HOGSEND_API_URL=https://tenant.example.test",
        "HOGSEND_API_KEY=hsk_live_1",
        "OTHER=keep",
        "",
      ].join("\n"),
    );
    // Order preserved, and exactly one assignment per key.
    expect(merged.content.match(/^HOGSEND_API_KEY=/gm)?.length).toBe(1);
    expect(merged.results.map((row) => row.outcome)).toEqual([
      "filled",
      "filled",
    ]);
  });

  it("refuses a different existing value and writes NOTHING", () => {
    const before = ["HOGSEND_API_KEY=hsk_i_am_using_this", "KEEP=1"].join("\n");
    const merged = mergeEnv(before, updates);

    expect(merged.conflicts).toEqual([KEY_KEY]);
    expect(merged.changed).toBe(false);
    // The URL would have been appended cleanly — it must NOT be, or a refused
    // pull leaves the file half-applied.
    expect(merged.content).toBe(before);
    expect(merged.content).not.toContain("tenant.example.test");
  });

  it("replaces a different existing value under force, and only that line", () => {
    const before = ["# keep me", "HOGSEND_API_KEY=hsk_old", "KEEP=1"].join(
      "\n",
    );
    const merged = mergeEnv(before, updates, { force: true });

    expect(merged.conflicts).toEqual([]);
    expect(merged.content).toContain("# keep me");
    expect(merged.content).toContain("KEEP=1");
    expect(merged.content).toContain("HOGSEND_API_KEY=hsk_live_1");
    expect(merged.content).not.toContain("hsk_old");
  });

  it("treats a quoted value as equal to the same unquoted one", () => {
    const before = `HOGSEND_API_KEY="hsk_live_1"`;
    const merged = mergeEnv(before, { [KEY_KEY]: "hsk_live_1" });
    expect(merged.conflicts).toEqual([]);
    expect(merged.changed).toBe(false);
    expect(merged.content).toBe(before);
    expect(merged.results[0]?.outcome).toBe("unchanged");
  });

  it("does not count a commented-out line as an assignment", () => {
    // Un-commenting a line someone disabled on purpose would be a silent
    // behaviour change, so the key is appended instead.
    const before = "# HOGSEND_API_KEY=hsk_disabled";
    const merged = mergeEnv(before, { [KEY_KEY]: "hsk_live_1" });
    expect(merged.content).toContain("# HOGSEND_API_KEY=hsk_disabled");
    expect(merged.content).toContain("\nHOGSEND_API_KEY=hsk_live_1");
    expect(merged.results[0]?.outcome).toBe("added");
  });

  it("does not confuse a key with one that merely starts the same", () => {
    const before = "HOGSEND_API_KEY_OLD=hsk_old";
    const merged = mergeEnv(before, { [KEY_KEY]: "hsk_live_1" });
    expect(merged.conflicts).toEqual([]);
    expect(merged.content).toContain("HOGSEND_API_KEY_OLD=hsk_old");
    expect(merged.results[0]?.outcome).toBe("added");
  });

  it("updates the LAST assignment, which is the one in force", () => {
    const before = ["HOGSEND_API_KEY=first", "HOGSEND_API_KEY=second"].join(
      "\n",
    );
    const merged = mergeEnv(
      before,
      { [KEY_KEY]: "hsk_live_1" },
      { force: true },
    );
    expect(merged.content).toBe(
      "HOGSEND_API_KEY=first\nHOGSEND_API_KEY=hsk_live_1\n",
    );
  });

  it("honours `export FOO=bar`, which a sourced .env really uses", () => {
    const merged = mergeEnv("export HOGSEND_API_KEY=hsk_old", updates, {
      force: true,
    });
    expect(merged.content).toContain("HOGSEND_API_KEY=hsk_live_1");
    expect(merged.content).not.toContain("hsk_old");
  });

  it("never puts a value in its outcome report", () => {
    const merged = mergeEnv("HOGSEND_API_KEY=hsk_secret_old", updates);
    expect(JSON.stringify(merged.results)).not.toContain("hsk_live_1");
    expect(JSON.stringify(merged.conflicts)).not.toContain("hsk_secret_old");
  });

  it("is idempotent — a second merge of the same values changes nothing", () => {
    const once = mergeEnv("DATABASE_URL=x\n", updates, { comment: "Hogsend" });
    const twice = mergeEnv(once.content, updates, { comment: "Hogsend" });
    expect(twice.content).toBe(once.content);
    expect(twice.changed).toBe(false);
    expect(twice.conflicts).toEqual([]);
  });
});
