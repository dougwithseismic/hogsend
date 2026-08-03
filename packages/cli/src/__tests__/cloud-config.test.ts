import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cloudHostKey,
  DEFAULT_CLOUD_URL,
  InsecureCloudUrlError,
  normalizeCloudUrl,
  resolveCloud,
} from "../lib/cloud-config.js";
import {
  NotLoggedInError,
  openCloudSession,
  requireCloudSession,
} from "../lib/cloud-session.js";
import { writeCloudCredential } from "../lib/credentials.js";

/**
 * The control plane's address is resolved SEPARATELY from an instance's
 * (`config.ts`'s `--url`), and these cases exist to keep it that way: a cwd
 * `.env` carrying `HOGSEND_API_URL` for a local engine must never become the
 * host a cloud credential is minted against or sent to.
 */

let cwd = "";
let home = "";
const SAVED = process.env.HOGSEND_CLOUD_URL;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "hogsend-cloudcfg-"));
  home = mkdtempSync(join(tmpdir(), "hogsend-cloudhome-"));
  delete process.env.HOGSEND_CLOUD_URL;
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  if (SAVED === undefined) delete process.env.HOGSEND_CLOUD_URL;
  else process.env.HOGSEND_CLOUD_URL = SAVED;
});

describe("resolveCloud", () => {
  it("defaults to the managed cloud", () => {
    const cloud = resolveCloud({}, cwd);
    expect(cloud.baseUrl).toBe(DEFAULT_CLOUD_URL);
    expect(cloud.host).toBe("cloud.hogsend.com");
    expect(cloud.explicit).toBe(false);
  });

  it("takes --cloud over the environment, and the environment over .env", () => {
    writeFileSync(
      join(cwd, ".env"),
      "HOGSEND_CLOUD_URL=https://dotenv.cloud.test\n",
    );
    expect(resolveCloud({}, cwd).host).toBe("dotenv.cloud.test");

    process.env.HOGSEND_CLOUD_URL = "https://env.cloud.test";
    expect(resolveCloud({}, cwd).host).toBe("env.cloud.test");

    const flagged = resolveCloud({ cloud: "https://flag.cloud.test" }, cwd);
    expect(flagged.host).toBe("flag.cloud.test");
    expect(flagged.explicit).toBe(true);
  });

  it("does NOT read HOGSEND_API_URL — an instance is not a control plane", () => {
    writeFileSync(join(cwd, ".env"), "HOGSEND_API_URL=http://localhost:3002\n");
    expect(resolveCloud({}, cwd).baseUrl).toBe(DEFAULT_CLOUD_URL);
  });

  it("normalises trailing slashes and a missing scheme into one key", () => {
    expect(normalizeCloudUrl("cloud.hogsend.com")).toBe(
      "https://cloud.hogsend.com",
    );
    expect(normalizeCloudUrl("https://cloud.hogsend.com/")).toBe(
      "https://cloud.hogsend.com",
    );
    // The port is part of the identity; the path never is.
    expect(cloudHostKey("http://localhost:3004")).toBe("localhost:3004");
    expect(cloudHostKey("https://Cloud.Hogsend.com")).toBe("cloud.hogsend.com");
  });
});

/**
 * The credentials key is `host[:port]` with NO scheme, so nothing downstream
 * can tell an https-minted token apart from an http one for the same host.
 * That is only safe while a plain-http remote cloud is refused outright —
 * otherwise a single `HOGSEND_CLOUD_URL` line in the cwd `.env` of a scaffold
 * repo (exactly where `hogsend publish` runs) puts the bearer on the wire in
 * cleartext, with no flag typed by anybody.
 */
describe("plain-http downgrade", () => {
  it("refuses a plain-http remote cloud, naming https as the fix", () => {
    const thrown = (() => {
      try {
        normalizeCloudUrl("http://cloud.hogsend.com");
      } catch (error) {
        return error;
      }
    })();

    expect(thrown).toBeInstanceOf(InsecureCloudUrlError);
    expect((thrown as InsecureCloudUrlError).baseUrl).toBe(
      "http://cloud.hogsend.com",
    );
    expect((thrown as Error).message).toContain("plain http");
    expect((thrown as Error).message).toContain("https://cloud.hogsend.com");
  });

  it("does NOT bind an https-minted credential to the http URL of the same host", () => {
    writeCloudCredential(
      "cloud.hogsend.com",
      { token: "hscli_prod_secret", createdAt: "2026-01-01T00:00:00.000Z" },
      home,
    );

    // https — the host the token was minted against — still resolves.
    expect(
      openCloudSession({ cloud: "https://cloud.hogsend.com", home, cwd })
        .credential?.token,
    ).toBe("hscli_prod_secret");

    // http, same host, same credentials key: the session must never open at
    // all, rather than open and attach the bearer over cleartext.
    expect(() =>
      openCloudSession({ cloud: "http://cloud.hogsend.com", home, cwd }),
    ).toThrow(InsecureCloudUrlError);
  });

  it("refuses the downgrade when it arrives via a cwd .env, with no flag", () => {
    writeFileSync(
      join(cwd, ".env"),
      "HOGSEND_CLOUD_URL=http://cloud.hogsend.com\n",
    );
    expect(() => resolveCloud({}, cwd)).toThrow(InsecureCloudUrlError);

    process.env.HOGSEND_CLOUD_URL = "http://cloud.hogsend.com";
    expect(() => resolveCloud({}, cwd)).toThrow(InsecureCloudUrlError);
  });

  it("still allows plain http to a loopback cloud — that is local dev", () => {
    expect(normalizeCloudUrl("http://localhost:3004")).toBe(
      "http://localhost:3004",
    );
    expect(normalizeCloudUrl("http://127.0.0.1:3004")).toBe(
      "http://127.0.0.1:3004",
    );
    expect(
      openCloudSession({ cloud: "http://localhost:3004", home, cwd }).cloud
        .baseUrl,
    ).toBe("http://localhost:3004");
  });
});

describe("cloud sessions", () => {
  it("binds the stored token for the resolved host and nothing else", () => {
    writeCloudCredential(
      "cloud.hogsend.com",
      { token: "hscli_managed", createdAt: "2026-01-01T00:00:00.000Z" },
      home,
    );

    const managed = openCloudSession({ home, cwd });
    expect(managed.credential?.token).toBe("hscli_managed");
    expect(managed.client.authenticated).toBe(true);

    // A different cloud gets NO credential — never the other one's.
    const other = openCloudSession({
      cloud: "https://cloud.acme.internal",
      home,
      cwd,
    });
    expect(other.credential).toBeUndefined();
    expect(other.client.authenticated).toBe(false);
  });

  it("refuses, with the right login command, when nothing is stored", () => {
    const error = (() => {
      try {
        requireCloudSession({
          cloud: "https://cloud.acme.internal",
          home,
          cwd,
        });
      } catch (thrown) {
        return thrown as NotLoggedInError;
      }
    })() as NotLoggedInError;

    expect(error).toBeInstanceOf(NotLoggedInError);
    expect(error.cloudHost).toBe("cloud.acme.internal");
    // An explicit --cloud is repeated back, so copy-pasting the hint works.
    expect(error.hint).toContain("--cloud https://cloud.acme.internal");
  });
});
