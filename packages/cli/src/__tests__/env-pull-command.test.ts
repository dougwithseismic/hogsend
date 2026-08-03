import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { envCommand } from "../commands/env.js";
import type { CommandContext } from "../commands/types.js";
import { writeCredentials } from "../lib/credentials.js";
import type { Output } from "../lib/output.js";

/**
 * `hogsend env pull`, driven through the real command against a scripted cloud.
 *
 * Not a unit test of the merge (that is `env-file.test.ts`) — this is the wiring
 * the merge cannot prove on its own: that the command reaches BOTH endpoints,
 * writes the file it says it wrote, refuses a conflict instead of clobbering,
 * exits nonzero on a refusal, and — the rule with no exceptions — never puts
 * the key on stdout, in ANY mode, including the failure ones.
 */

const CLOUD = "http://localhost:3999";
const API_URL = "https://tenant.example.test";
const API_KEY = "hsk_super_secret_value_9f2a";
const ENV_ID = "1c3f0f2e-0000-4000-8000-000000000001";

class FailSignal extends Error {
  constructor(readonly failMessage: string) {
    super(failMessage);
    this.name = "FailSignal";
  }
}

let home = "";
let work = "";
let realFetch: typeof globalThis.fetch;
let calls: string[] = [];

/** Everything the command wrote anywhere a human or a log would see it. */
interface Captured {
  lines: string[];
  docs: unknown[];
  /** logs + json + the fail message, concatenated. The scrollback. */
  all(): string;
}

function makeCtx(
  argv: string[],
  json = false,
): { ctx: CommandContext; captured: Captured } {
  const lines: string[] = [];
  const docs: unknown[] = [];
  let failed = "";

  const out: Output = {
    isJson: json,
    interactive: false,
    intro(title) {
      if (!json) lines.push(title);
    },
    async step(label, fn) {
      if (!json) lines.push(label);
      return fn();
    },
    note(body, title) {
      if (!json) lines.push(`${title ?? ""}${body}`);
    },
    table() {},
    kv() {},
    log(msg) {
      if (!json) lines.push(msg);
    },
    json(payload) {
      docs.push(payload);
    },
    outro(msg) {
      if (!json) lines.push(msg);
    },
    fail(message): never {
      failed = message;
      throw new FailSignal(message);
    },
  } as Output;

  return {
    ctx: {
      argv,
      cfg: {} as CommandContext["cfg"],
      http: {} as CommandContext["http"],
      dataHttp: {} as CommandContext["dataHttp"],
      out,
      json,
    },
    captured: {
      lines,
      docs,
      all: () => [...lines, JSON.stringify(docs), failed].join("\n"),
    },
  };
}

/** The control plane, scripted. `overrides` replaces one route's answer. */
function scriptCloud(
  overrides: Record<string, { status: number; body: unknown }> = {},
): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const path = url.slice(CLOUD.length);
    calls.push(path);

    const override = overrides[path];
    if (override) {
      return new Response(JSON.stringify(override.body), {
        status: override.status,
        headers: { "content-type": "application/json" },
      });
    }
    if (path === "/api/cli/environments") {
      return Response.json({
        organization: { id: "org1", name: "Acme" },
        environments: [
          {
            id: ENV_ID,
            name: "production",
            kind: "production",
            stackStatus: "running",
            engineVersion: "0.61.0",
          },
        ],
      });
    }
    if (path === `/api/cli/environments/${ENV_ID}/credentials`) {
      return Response.json({
        environmentId: ENV_ID,
        apiUrl: API_URL,
        apiKey: API_KEY,
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof globalThis.fetch;
}

beforeEach(() => {
  realFetch = globalThis.fetch;
  calls = [];
  home = mkdtempSync(join(tmpdir(), "hogsend-home-"));
  work = mkdtempSync(join(tmpdir(), "hogsend-work-"));
  process.env.HOME = home;
  writeCredentials(
    {
      version: 1,
      clouds: {
        "localhost:3999": {
          token: "hscli_test_token",
          host: "localhost:3999",
          email: "owner@acme.test",
          organizationId: "org1",
        } as never,
      },
    } as never,
    home,
  );
  scriptCloud();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const args = (extra: string[] = []) => [
  "pull",
  "--cloud",
  CLOUD,
  "--cwd",
  work,
  ...extra,
];

const envPath = () => join(work, ".env");

describe("hogsend env pull", () => {
  it("creates .env, at 0600, from both cloud reads", async () => {
    const { ctx } = makeCtx(args());
    await envCommand.run(ctx);

    expect(calls).toEqual([
      "/api/cli/environments",
      `/api/cli/environments/${ENV_ID}/credentials`,
    ]);

    const written = readFileSync(envPath(), "utf8");
    expect(written).toContain(`HOGSEND_API_URL=${API_URL}`);
    expect(written).toContain(`HOGSEND_API_KEY=${API_KEY}`);
    // A file that is about to hold a live API key does not inherit the umask.
    expect(statSync(envPath()).mode & 0o777).toBe(0o600);
  });

  it("never puts the key on stdout — not in the message, not under --json", async () => {
    const human = makeCtx(args());
    await envCommand.run(human.ctx);
    expect(human.captured.all()).not.toContain(API_KEY);
    // …while still saying enough to be useful.
    expect(human.captured.all()).toContain("HOGSEND_API_KEY");
    expect(human.captured.all()).toContain(envPath());

    const machine = makeCtx(args(), true);
    await envCommand.run(machine.ctx);
    expect(machine.captured.all()).not.toContain(API_KEY);
    const doc = machine.captured.docs[0] as {
      path: string;
      apiUrl: string;
      variables: Record<string, string>;
    };
    expect(doc.path).toBe(envPath());
    expect(doc.apiUrl).toBe(API_URL);
    expect(doc.variables.HOGSEND_API_KEY).toBe("unchanged");
  });

  it("merges into an existing file, leaving every other line alone", async () => {
    const before = [
      "# my app",
      "DATABASE_URL=postgres://localhost/app",
      "",
      "RESEND_API_KEY=re_keep_me",
      "",
    ].join("\n");
    writeFileSync(envPath(), before);

    const { ctx } = makeCtx(args());
    await envCommand.run(ctx);

    const after = readFileSync(envPath(), "utf8");
    expect(after.startsWith(before)).toBe(true);
    expect(after).toContain("# my app");
    expect(after).toContain("RESEND_API_KEY=re_keep_me");
    expect(after).toContain(`HOGSEND_API_KEY=${API_KEY}`);
  });

  it("running twice does not corrupt or duplicate anything", async () => {
    await envCommand.run(makeCtx(args()).ctx);
    const once = readFileSync(envPath(), "utf8");
    const second = makeCtx(args());
    await envCommand.run(second.ctx);
    const twice = readFileSync(envPath(), "utf8");

    expect(twice).toBe(once);
    expect(twice.match(/^HOGSEND_API_KEY=/gm)?.length).toBe(1);
    expect(second.captured.all()).toContain("Already up to date");
  });

  it("refuses a conflicting existing key and leaves the file untouched", async () => {
    const before = "HOGSEND_API_KEY=hsk_i_am_using_this\nKEEP=1\n";
    writeFileSync(envPath(), before);

    const { ctx, captured } = makeCtx(args());
    await expect(envCommand.run(ctx)).rejects.toBeInstanceOf(FailSignal);

    // Nothing written, including the URL that had no conflict of its own.
    expect(readFileSync(envPath(), "utf8")).toBe(before);
    expect(captured.all()).toContain("HOGSEND_API_KEY");
    expect(captured.all()).toContain("--force");
    // The refusal itself must not quote either key.
    expect(captured.all()).not.toContain(API_KEY);
    expect(captured.all()).not.toContain("hsk_i_am_using_this");
  });

  it("replaces the conflicting value under --force", async () => {
    writeFileSync(envPath(), "HOGSEND_API_KEY=hsk_old\nKEEP=1\n");
    const { ctx } = makeCtx(args(["--force"]));
    await envCommand.run(ctx);

    const after = readFileSync(envPath(), "utf8");
    expect(after).toContain(`HOGSEND_API_KEY=${API_KEY}`);
    expect(after).not.toContain("hsk_old");
    expect(after).toContain("KEEP=1");
  });

  it("renders a role refusal through the shared refusal vocabulary", async () => {
    scriptCloud({
      [`/api/cli/environments/${ENV_ID}/credentials`]: {
        status: 403,
        body: {
          error: "forbidden_role_credentials",
          message: "Your role in Acme (member) cannot read credentials.",
        },
      },
    });

    const { ctx, captured } = makeCtx(args());
    await expect(envCommand.run(ctx)).rejects.toBeInstanceOf(FailSignal);
    expect(captured.all()).toContain("cannot read credentials");
    expect(captured.all()).toContain("owner or admin");
    // The refusal came before any write.
    expect(() => statSync(envPath())).toThrow();
  });

  it("explains a stack that is not ready, and writes nothing", async () => {
    scriptCloud({
      [`/api/cli/environments/${ENV_ID}/credentials`]: {
        status: 409,
        body: {
          error: "tenant_access_unavailable",
          message: "This instance is still being set up.",
        },
      },
    });

    const { ctx, captured } = makeCtx(args());
    await expect(envCommand.run(ctx)).rejects.toBeInstanceOf(FailSignal);
    expect(captured.all()).toContain("still being set up");
    expect(captured.all()).toContain("hogsend open");
    expect(() => statSync(envPath())).toThrow();
  });

  it("names the environments that exist when --env misses", async () => {
    const { ctx, captured } = makeCtx(args(["--env", "stagign"]));
    await expect(envCommand.run(ctx)).rejects.toBeInstanceOf(FailSignal);
    expect(captured.all()).toContain("stagign");
    expect(captured.all()).toContain("production");
    // A typo must not silently pull production's credentials.
    expect(calls).not.toContain(`/api/cli/environments/${ENV_ID}/credentials`);
  });

  it("refuses with no stored session, before touching the network", async () => {
    writeCredentials({ version: 1, clouds: {} } as never, home);
    const { ctx, captured } = makeCtx(args());
    await expect(envCommand.run(ctx)).rejects.toBeInstanceOf(FailSignal);
    expect(captured.all()).toContain("hogsend login");
    expect(calls).toEqual([]);
  });
});
