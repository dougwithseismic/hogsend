import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CREDENTIALS_MODE,
  credentialsPath,
  deleteCloudCredential,
  readCloudCredential,
  readCredentials,
  writeCloudCredential,
  writeCredentials,
} from "../lib/credentials.js";

/**
 * The credentials file is the ONE place a cloud session token lives on disk, so
 * these cases are about the file itself rather than about what is in it: its
 * mode on create AND on rewrite, that a write is atomic, that a corrupt file
 * degrades to "logged out" instead of to a stack trace, and that two clouds
 * cannot see each other's token.
 *
 * Every case uses a temp HOME. Nothing here can touch a real ~/.hogsend.
 */

let home = "";

const TOKEN = "hscli_fixture_secret_do_not_log";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "hogsend-creds-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

describe("credentials file", () => {
  it("creates the file at 0600 in a 0700 directory", () => {
    writeCloudCredential(
      "cloud.hogsend.com",
      { token: TOKEN, createdAt: new Date().toISOString() },
      home,
    );

    const file = credentialsPath(home);
    expect(mode(file)).toBe(CREDENTIALS_MODE);
    expect(mode(join(home, ".hogsend"))).toBe(0o700);
  });

  it("re-asserts 0600 on REWRITE of a file that was left world-readable", () => {
    writeCloudCredential(
      "cloud.hogsend.com",
      { token: TOKEN, createdAt: new Date().toISOString() },
      home,
    );

    // The failure this guards: `writeFileSync`'s `mode` applies only on
    // CREATE, so a file that became 0644 (a restore, a synced dotfiles repo, a
    // permissive umask) would stay 0644 through every later login.
    const file = credentialsPath(home);
    chmodSync(file, 0o644);
    expect(mode(file)).toBe(0o644);

    writeCloudCredential(
      "cloud.hogsend.com",
      { token: `${TOKEN}-2`, createdAt: new Date().toISOString() },
      home,
    );
    expect(mode(file)).toBe(CREDENTIALS_MODE);
    expect(readCloudCredential("cloud.hogsend.com", home)?.token).toBe(
      `${TOKEN}-2`,
    );
  });

  it("leaves no temp file behind, and replaces atomically", () => {
    writeCloudCredential(
      "cloud.hogsend.com",
      { token: TOKEN, createdAt: new Date().toISOString() },
      home,
    );
    writeCloudCredential(
      "cloud.hogsend.com",
      { token: `${TOKEN}-again`, createdAt: new Date().toISOString() },
      home,
    );

    const dir = join(home, ".hogsend");
    const files = readFileSync(credentialsPath(home), "utf8");
    // The rename target is the only file in the directory: no `.tmp` remnants.
    expect(readdirSync(dir).sort()).toEqual(["credentials.json"]);
    // ...and the surviving document is the LAST write in full, never a merge
    // of two halves.
    expect(JSON.parse(files)).toEqual({
      clouds: {
        "cloud.hogsend.com": {
          token: `${TOKEN}-again`,
          createdAt: expect.any(String),
        },
      },
    });
  });

  it("keeps one entry per cloud host, keyed case-insensitively", () => {
    writeCloudCredential(
      "cloud.hogsend.com",
      { token: "hscli_managed", createdAt: "2026-01-01T00:00:00.000Z" },
      home,
    );
    writeCloudCredential(
      "Cloud.Acme.Internal",
      { token: "hscli_self_hosted", createdAt: "2026-01-01T00:00:00.000Z" },
      home,
    );

    expect(readCloudCredential("cloud.hogsend.com", home)?.token).toBe(
      "hscli_managed",
    );
    expect(readCloudCredential("cloud.acme.internal", home)?.token).toBe(
      "hscli_self_hosted",
    );
    // A host nobody logged into has no token, not somebody else's.
    expect(readCloudCredential("cloud.other.test", home)).toBeUndefined();
  });

  it("forgets exactly one host, and reports whether there was anything to forget", () => {
    writeCloudCredential(
      "a.test",
      { token: "hscli_a", createdAt: "2026-01-01T00:00:00.000Z" },
      home,
    );
    writeCloudCredential(
      "b.test",
      { token: "hscli_b", createdAt: "2026-01-01T00:00:00.000Z" },
      home,
    );

    expect(deleteCloudCredential("a.test", home)).toBe(true);
    expect(readCloudCredential("a.test", home)).toBeUndefined();
    expect(readCloudCredential("b.test", home)?.token).toBe("hscli_b");
    // Idempotent, and honest about it — `hogsend logout` says "nothing to do".
    expect(deleteCloudCredential("a.test", home)).toBe(false);

    // The mode survives a delete-rewrite too.
    expect(mode(credentialsPath(home))).toBe(CREDENTIALS_MODE);
  });

  it("reads a missing, corrupt or wrong-shaped file as EMPTY, never throwing", () => {
    expect(readCredentials(home)).toEqual({ clouds: {} });

    mkdirSync(join(home, ".hogsend"), { recursive: true });
    writeFileSync(credentialsPath(home), "{ not json");
    expect(readCredentials(home)).toEqual({ clouds: {} });

    writeFileSync(credentialsPath(home), JSON.stringify({ clouds: "nope" }));
    expect(readCredentials(home)).toEqual({ clouds: {} });

    // An entry with no token is not a credential and is dropped, rather than
    // becoming an `undefined` bearer on the next request.
    writeFileSync(
      credentialsPath(home),
      JSON.stringify({ clouds: { "a.test": { userLabel: "x" } } }),
    );
    expect(readCredentials(home)).toEqual({ clouds: {} });
  });

  it("round-trips the optional labels", () => {
    writeCredentials(
      {
        clouds: {
          "a.test": {
            token: "hscli_a",
            userLabel: "doug@hogsend.test",
            orgLabel: "Acme",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        },
      },
      home,
    );
    expect(readCloudCredential("a.test", home)).toEqual({
      token: "hscli_a",
      userLabel: "doug@hogsend.test",
      orgLabel: "Acme",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });
});
