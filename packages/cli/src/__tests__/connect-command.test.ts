import { describe, expect, it } from "vitest";
import { connectCommand } from "../commands/connect.js";
import type { CommandContext } from "../commands/types.js";
import type { ResolvedConfig } from "../lib/config.js";
import type { AdminClient } from "../lib/http.js";
import type { Output } from "../lib/output.js";

// Thin argv/usage mapping only — the flow itself is covered by
// connect-flow.test.ts (stub-CommandContext harness, domain-command style).

/** Sentinel thrown by the stubbed `out.fail` instead of process.exit(1). */
class FailSignal extends Error {
  constructor(readonly failMessage: string) {
    super(failMessage);
    this.name = "FailSignal";
  }
}

function makeCtx(argv: string[]): {
  ctx: CommandContext;
  logs: string[];
  httpCalls: string[];
} {
  const logs: string[] = [];
  const httpCalls: string[] = [];

  const out: Output = {
    interactive: false,
    isJson: false,
    intro: () => {},
    step: async <T>(_label: string, fn: () => Promise<T>) => fn(),
    note: (body: string) => {
      logs.push(body);
    },
    table: () => {},
    kv: () => {},
    log: (msg: string) => {
      logs.push(msg);
    },
    json: () => {},
    outro: () => {},
    fail: (message: string): never => {
      throw new FailSignal(message);
    },
  };

  const cfg = {
    baseUrl: "http://localhost:3002",
    adminKey: "hsk_test",
    dataKey: undefined,
    sources: { baseUrl: "default", adminKey: "flag", dataKey: "default" },
  } as unknown as ResolvedConfig;

  const reject = (verb: string) => () => {
    httpCalls.push(verb);
    return Promise.reject(new Error(`unexpected ${verb}`));
  };
  const http = {
    cfg,
    get: reject("GET"),
    post: reject("POST"),
    put: reject("PUT"),
    patch: reject("PATCH"),
    del: reject("DELETE"),
  } as unknown as AdminClient;

  const ctx: CommandContext = {
    argv,
    cfg,
    http,
    dataHttp: {} as CommandContext["dataHttp"],
    out,
    json: false,
  };

  return { ctx, logs, httpCalls };
}

describe("hogsend connect — argv mapping", () => {
  it("fails when the provider positional is missing", async () => {
    const { ctx } = makeCtx([]);
    await expect(connectCommand.run(ctx)).rejects.toThrow(/missing provider/i);
  });

  it("fails on an unknown provider and lists both supported", async () => {
    const { ctx } = makeCtx(["stripe"]);
    await expect(connectCommand.run(ctx)).rejects.toThrow(
      /unknown provider "stripe" — supported: posthog, discord/,
    );
  });

  it("refuses to PUT discord secrets over plain http to a remote instance", async () => {
    const { ctx } = makeCtx(["discord"]);
    // Default makeCtx baseUrl is http://localhost:3002 (loopback) — point it
    // at a plain-http REMOTE host to trip the secret-PUT refusal.
    (ctx.cfg as { baseUrl: string }).baseUrl = "http://remote.example.com";
    (ctx.http.cfg as { baseUrl: string }).baseUrl = "http://remote.example.com";
    await expect(connectCommand.run(ctx)).rejects.toThrow(
      /refusing to send the Discord bot token/i,
    );
  });

  it("rejects --provision-only with --no-provision", async () => {
    const { ctx } = makeCtx(["posthog", "--provision-only", "--no-provision"]);
    await expect(connectCommand.run(ctx)).rejects.toThrow(/mutually exclusive/);
  });

  it("--help prints usage and makes no HTTP calls", async () => {
    const { ctx, logs, httpCalls } = makeCtx(["posthog", "--help"]);
    await connectCommand.run(ctx);
    expect(logs.join("\n")).toContain("hogsend connect <provider>");
    expect(logs.join("\n")).toContain("--provision-only");
    expect(httpCalls).toHaveLength(0);
  });
});
