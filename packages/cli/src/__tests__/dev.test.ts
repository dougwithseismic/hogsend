import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  devCommand,
  fetchDomainLine,
  renderDomainLine,
} from "../commands/dev.js";
import type { CommandContext } from "../commands/types.js";
import type { ResolvedConfig } from "../lib/config.js";
import type { AdminClient, DataPlaneClient, Query } from "../lib/http.js";
import type { Output } from "../lib/output.js";

vi.mock("../lib/proc.js", () => ({
  spawnManaged: vi.fn(),
  shutdownAll: vi.fn(async () => {}),
  waitForHttp: vi.fn(async () => {}),
}));

import { spawnManaged } from "../lib/proc.js";

/** Sentinel thrown by the stubbed `out.fail` instead of process.exit(1). */
class FailSignal extends Error {
  constructor(readonly failMessage: string) {
    super(failMessage);
    this.name = "FailSignal";
  }
}

interface Captured {
  logs: string[];
  jsonDocs: unknown[];
}

function makeCtx(opts: {
  argv: string[];
  json?: boolean;
  adminKey?: string;
  get?: (path: string, query?: Query) => Promise<unknown>;
  post?: (path: string, body: unknown) => Promise<unknown>;
}): { ctx: CommandContext; captured: Captured } {
  const captured: Captured = { logs: [], jsonDocs: [] };

  const out: Output = {
    interactive: false,
    isJson: opts.json ?? false,
    intro: () => {},
    step: async <T>(_label: string, fn: () => Promise<T>) => fn(),
    note: (body: string) => {
      captured.logs.push(body);
    },
    table: () => {},
    kv: () => {},
    log: (msg: string) => {
      captured.logs.push(msg);
    },
    json: (payload: unknown) => {
      captured.jsonDocs.push(payload);
    },
    outro: () => {},
    fail: (message: string): never => {
      throw new FailSignal(message);
    },
  };

  const cfg = {
    baseUrl: "http://localhost:3002",
    adminKey: opts.adminKey,
    dataKey: "hsk_data",
  } as ResolvedConfig;

  const http = {
    cfg,
    get: (path: string, query?: Query) =>
      (opts.get ?? (() => Promise.reject(new Error("unexpected GET"))))(
        path,
        query,
      ),
    post: () => Promise.reject(new Error("unexpected POST")),
    patch: () => Promise.reject(new Error("unexpected PATCH")),
    del: () => Promise.reject(new Error("unexpected DELETE")),
  } as AdminClient;

  const dataHttp = {
    cfg,
    get: () => Promise.reject(new Error("unexpected data GET")),
    post: (path: string, body: unknown) =>
      (opts.post ?? (() => Promise.reject(new Error("unexpected data POST"))))(
        path,
        body,
      ),
    put: () => Promise.reject(new Error("unexpected PUT")),
    del: () => Promise.reject(new Error("unexpected DELETE")),
  } as DataPlaneClient;

  const ctx: CommandContext = {
    argv: opts.argv,
    cfg,
    http,
    dataHttp,
    out,
    json: opts.json ?? false,
  };

  return { ctx, captured };
}

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "hogsend-dev-"));
  vi.mocked(spawnManaged).mockClear();
  vi.unstubAllGlobals();
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe("hogsend dev --help", () => {
  it("prints usage and exits cleanly", async () => {
    const { ctx, captured } = makeCtx({ argv: ["--help"] });
    await devCommand.run(ctx);
    const all = captured.logs.join("\n");
    expect(all).toContain("hogsend dev");
    expect(all).toContain("--fire");
    expect(all).toContain("--no-worker");
    expect(all).toContain("--no-infra");
    expect(vi.mocked(spawnManaged)).not.toHaveBeenCalled();
  });
});

describe("hogsend dev app detection", () => {
  it("fails with 'not a Hogsend app' in an empty directory", async () => {
    const { ctx } = makeCtx({ argv: ["--cwd", cwd] });
    await expect(devCommand.run(ctx)).rejects.toThrow(/not a Hogsend app/i);
    expect(vi.mocked(spawnManaged)).not.toHaveBeenCalled();
  });

  it("names the missing worker:dev script", async () => {
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({
        name: "app",
        scripts: { dev: "tsx watch src/index.ts" },
        dependencies: { "@hogsend/engine": "^0.11.0" },
      }),
    );
    const { ctx } = makeCtx({ argv: ["--cwd", cwd] });
    await expect(devCommand.run(ctx)).rejects.toThrow(/worker:dev/);
  });

  it("names the missing @hogsend/engine dependency", async () => {
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({
        name: "app",
        scripts: { dev: "x", "worker:dev": "y" },
        dependencies: {},
      }),
    );
    const { ctx } = makeCtx({ argv: ["--cwd", cwd] });
    await expect(devCommand.run(ctx)).rejects.toThrow(/@hogsend\/engine/);
  });
});

describe("hogsend dev --fire", () => {
  it("delegates to the events send path without booting anything", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true })),
    );
    let seenPath: string | undefined;
    let seenBody: unknown;
    const { ctx } = makeCtx({
      argv: ["--fire", "signup", "--email", "a@b.com", "--prop", "plan=pro"],
      post: async (path, body) => {
        seenPath = path;
        seenBody = body;
        return { stored: true, exits: [] };
      },
    });
    await devCommand.run(ctx);
    expect(seenPath).toBe("/v1/events");
    expect(seenBody).toEqual({
      name: "signup",
      email: "a@b.com",
      eventProperties: { plan: "pro" },
    });
    expect(vi.mocked(spawnManaged)).not.toHaveBeenCalled();
  });

  it("supports --fire=<event> syntax", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true })),
    );
    let seenBody: unknown;
    const { ctx } = makeCtx({
      argv: ["--fire=signup", "--user-id", "u_1"],
      post: async (_path, body) => {
        seenBody = body;
        return { stored: true, exits: [] };
      },
    });
    await devCommand.run(ctx);
    expect(seenBody).toEqual({ name: "signup", userId: "u_1" });
  });

  it("fails when --fire has no event name", async () => {
    const { ctx } = makeCtx({ argv: ["--fire"] });
    await expect(devCommand.run(ctx)).rejects.toThrow(
      /--fire requires an event name/,
    );
  });

  it("fails with a friendly hint when the instance is down", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const { ctx } = makeCtx({
      argv: ["--fire", "signup", "--user-id", "u_1"],
    });
    await expect(devCommand.run(ctx)).rejects.toThrow(
      /is hogsend dev running/i,
    );
    expect(vi.mocked(spawnManaged)).not.toHaveBeenCalled();
  });
});

describe("renderDomainLine", () => {
  it("renders a yellow test-mode line with the redirect target", () => {
    const line = renderDomainLine({
      domain: "mysite.com",
      status: { state: "pending" },
      testMode: { active: true, redirectTo: "doug@x.dev" },
    });
    expect(line).toContain("Test mode active");
    expect(line).toContain("doug@x.dev");
    expect(line).toContain("pending");
  });

  it("renders a verified domain line", () => {
    const line = renderDomainLine({
      domain: "mysite.com",
      status: { state: "verified" },
      testMode: { active: false, redirectTo: null },
    });
    expect(line).toContain("mysite.com");
    expect(line).toContain("verified");
  });

  it("returns null when there is nothing to say", () => {
    expect(
      renderDomainLine({
        domain: null,
        status: null,
        testMode: { active: false, redirectTo: null },
      }),
    ).toBeNull();
  });
});

describe("fetchDomainLine (guarded soft-consume of /v1/admin/domain)", () => {
  it("returns null without calling HTTP when no admin key is configured", async () => {
    const get = vi.fn();
    const { ctx } = makeCtx({ argv: [], get });
    await expect(fetchDomainLine(ctx)).resolves.toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it("returns null when the route 404s (engine without domain-setup)", async () => {
    const { ctx } = makeCtx({
      argv: [],
      adminKey: "hsk_admin",
      get: async () => {
        const err = new Error("request failed with status 404");
        (err as Error & { status: number }).status = 404;
        throw err;
      },
    });
    await expect(fetchDomainLine(ctx)).resolves.toBeNull();
  });

  it("returns the rendered line on success", async () => {
    const { ctx } = makeCtx({
      argv: [],
      adminKey: "hsk_admin",
      get: async (path) => {
        expect(path).toBe("/v1/admin/domain");
        return {
          domain: "mysite.com",
          status: { state: "verified" },
          testMode: { active: false, redirectTo: null },
        };
      },
    });
    const line = await fetchDomainLine(ctx);
    expect(line).toContain("mysite.com");
  });

  it("returns null on a malformed response body", async () => {
    const { ctx } = makeCtx({
      argv: [],
      adminKey: "hsk_admin",
      get: async () => "weird",
    });
    await expect(fetchDomainLine(ctx)).resolves.toBeNull();
  });
});

describe("hogsend dev infra gating", () => {
  it("requires package.json before doing anything else (cwd is a dir)", async () => {
    mkdirSync(join(cwd, "sub"));
    const { ctx } = makeCtx({ argv: ["--cwd", join(cwd, "sub")] });
    await expect(devCommand.run(ctx)).rejects.toThrow(/package\.json/);
  });
});
