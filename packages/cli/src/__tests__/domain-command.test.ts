import type { EngineDomainStatus } from "@hogsend/engine";
import { describe, expect, it, vi } from "vitest";
import { domainCommand } from "../commands/domain.js";
import type { CommandContext } from "../commands/types.js";
import type { ResolvedConfig } from "../lib/config.js";
import type { AdminClient, HttpError, Query } from "../lib/http.js";
import type { Output } from "../lib/output.js";

// NEVER hit real DNS in tests: `domain add`'s host detection walks NS records
// via node:dns/promises. A rejecting resolver resolves to the "unknown" host
// (detectDnsHost never throws), keeping the add flow deterministic + offline.
vi.mock("node:dns/promises", () => ({
  resolveNs: () => Promise.reject(new Error("no DNS lookups in tests")),
}));

/** Sentinel thrown by the stubbed `out.fail` instead of process.exit(1). */
class FailSignal extends Error {
  constructor(readonly failMessage: string) {
    super(failMessage);
    this.name = "FailSignal";
  }
}

function makeHttpError(status: number, body: unknown): HttpError {
  const err = new Error(
    body &&
      typeof body === "object" &&
      "error" in body &&
      typeof (body as { error: unknown }).error === "string"
      ? `${status}: ${(body as { error: string }).error}`
      : `request failed with status ${status}`,
  ) as HttpError;
  err.name = "HttpError";
  err.status = status;
  err.body = body;
  return err;
}

const STATUS_FIXTURE: EngineDomainStatus = {
  domain: "mysite.com",
  providerId: "resend",
  supported: true,
  status: {
    domain: "mysite.com",
    state: "pending",
    records: [
      {
        type: "TXT",
        name: "resend._domainkey.mysite.com",
        value: "p=MIGfMA0GCSq",
        purpose: "dkim",
        status: "pending",
      },
    ],
    providerId: "resend",
    checkedAt: "2026-06-09T00:00:00.000Z",
  },
  testMode: {
    active: false,
    reason: null,
    redirectTo: null,
    fromOverride: null,
  },
  // The engine's SENDING_DOMAIN_GUIDANCE words, as the wire carries them.
  // Hand-written test data, NOT a drift risk: the CLI renders whatever
  // `GET /v1/admin/domain` returns verbatim (it holds no copy of its own), so
  // these strings only feed the plumbing assertions below. (The engine barrel
  // cannot be value-imported here — it validates server env at module eval.)
  guidance: {
    title: "Send from a subdomain",
    body: "Use notifications.acme.com rather than acme.com. Spam complaints damage the reputation of the domain that sent the mail, and your root domain also carries your password resets, invoices and contracts. A subdomain keeps that damage in one place.",
    note: "Root domains work. This is a recommendation, not a requirement.",
    recommendedLabels: ["notifications", "mail", "updates"],
  },
};

interface CapturedOutput {
  logs: string[];
  jsonDocs: unknown[];
}

function makeCtx(opts: {
  argv: string[];
  json?: boolean;
  get?: (path: string, query?: Query) => Promise<unknown>;
  post?: (path: string, body: unknown) => Promise<unknown>;
}): { ctx: CommandContext; captured: CapturedOutput } {
  const captured: CapturedOutput = { logs: [], jsonDocs: [] };

  const out: Output = {
    interactive: false,
    isJson: opts.json ?? false,
    intro: () => {},
    step: async <T>(_label: string, fn: () => Promise<T>) => fn(),
    note: (body: string, title?: string) => {
      captured.logs.push(title ? `${title}\n${body}` : body);
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
    adminKey: "hsk_test",
    dataKey: undefined,
    sources: { baseUrl: "default", adminKey: "flag", dataKey: "default" },
  } as unknown as ResolvedConfig;

  const http = {
    cfg,
    get: (path: string, query?: Query) =>
      (opts.get ?? (() => Promise.reject(new Error("unexpected GET"))))(
        path,
        query,
      ),
    post: (path: string, body: unknown) =>
      (opts.post ?? (() => Promise.reject(new Error("unexpected POST"))))(
        path,
        body,
      ),
    patch: () => Promise.reject(new Error("unexpected PATCH")),
    put: () => Promise.reject(new Error("unexpected PUT")),
    del: () => Promise.reject(new Error("unexpected DELETE")),
  } as AdminClient;

  const ctx: CommandContext = {
    argv: opts.argv,
    cfg,
    http,
    dataHttp: {} as CommandContext["dataHttp"],
    out,
    json: opts.json ?? false,
  };

  return { ctx, captured };
}

describe("hogsend domain --help", () => {
  it("prints usage and exits cleanly (exit 0)", async () => {
    const { ctx, captured } = makeCtx({ argv: ["--help"] });
    await domainCommand.run(ctx);
    expect(captured.logs.join("\n")).toContain("hogsend domain");
    expect(captured.logs.join("\n")).toContain("add <domain>");
  });

  it("prints usage when no subcommand is given", async () => {
    const { ctx, captured } = makeCtx({ argv: [] });
    await domainCommand.run(ctx);
    expect(captured.logs.join("\n")).toContain("hogsend domain");
  });

  it("fails on an unknown subcommand", async () => {
    const { ctx } = makeCtx({ argv: ["frobnicate"] });
    await expect(domainCommand.run(ctx)).rejects.toThrow(/unknown subcommand/i);
  });
});

describe("hogsend domain status", () => {
  it("--json emits the EngineDomainStatus as a single parseable document", async () => {
    const { ctx, captured } = makeCtx({
      argv: ["status"],
      json: true,
      get: async (path, query) => {
        expect(path).toBe("/v1/admin/domain");
        expect(query?.refresh).toBeUndefined();
        return STATUS_FIXTURE;
      },
    });
    await domainCommand.run(ctx);
    expect(captured.jsonDocs).toHaveLength(1);
    const doc = JSON.parse(JSON.stringify(captured.jsonDocs[0]));
    expect(doc).toEqual(STATUS_FIXTURE);
    expect(doc.testMode).toEqual({
      active: false,
      reason: null,
      redirectTo: null,
      fromOverride: null,
    });
  });

  it("--refresh passes ?refresh=true", async () => {
    let seenQuery: Query | undefined;
    const { ctx } = makeCtx({
      argv: ["status", "--refresh"],
      json: true,
      get: async (_path, query) => {
        seenQuery = query;
        return STATUS_FIXTURE;
      },
    });
    await domainCommand.run(ctx);
    expect(seenQuery?.refresh).toBe("true");
  });
});

describe("hogsend domain add", () => {
  it("fails with the unsupported message on a 501 provider_unsupported", async () => {
    const { ctx } = makeCtx({
      argv: ["add", "mysite.com"],
      post: async () => {
        throw makeHttpError(501, { error: "provider_unsupported" });
      },
      // The command resolves the provider id for the message via GET.
      get: async () => ({
        ...STATUS_FIXTURE,
        providerId: "smtp",
        supported: false,
        status: null,
      }),
    });
    await expect(domainCommand.run(ctx)).rejects.toThrow(
      /provider smtp does not support domain management/,
    );
  });

  it("fails when the domain argument is missing", async () => {
    const { ctx } = makeCtx({ argv: ["add"] });
    await expect(domainCommand.run(ctx)).rejects.toThrow(/missing <domain>/i);
  });

  it("fails on an invalid domain before any HTTP call", async () => {
    const { ctx } = makeCtx({ argv: ["add", "not_a_domain"] });
    await expect(domainCommand.run(ctx)).rejects.toThrow(/invalid domain/i);
  });

  it("prints the sending-subdomain guidance for a root domain — and still POSTs (never a gate)", async () => {
    const posts: Array<{ path: string; body: unknown }> = [];
    const { ctx, captured } = makeCtx({
      argv: ["add", "mysite.com"],
      get: async (path) => {
        expect(path).toBe("/v1/admin/domain");
        return STATUS_FIXTURE;
      },
      post: async (path, body) => {
        posts.push({ path, body });
        return STATUS_FIXTURE;
      },
    });
    await domainCommand.run(ctx);
    const output = captured.logs.join("\n");
    expect(output).toContain("Send from a subdomain");
    // Suggestion is personalised to the TYPED domain (mysite.com never
    // appears in the static copy, so this proves the concrete build).
    expect(output).toContain("notifications.mysite.com");
    // The EARS criterion: the warning informs, it never gates the POST.
    expect(posts).toEqual([
      { path: "/v1/admin/domain", body: { domain: "mysite.com" } },
    ]);
  });

  it("does not nag when a subdomain is entered", async () => {
    const gets: string[] = [];
    const posts: unknown[] = [];
    const { ctx, captured } = makeCtx({
      argv: ["add", "notifications.mysite.com"],
      get: async (path) => {
        gets.push(path);
        return STATUS_FIXTURE;
      },
      post: async (_path, body) => {
        posts.push(body);
        return STATUS_FIXTURE;
      },
    });
    await domainCommand.run(ctx);
    expect(captured.logs.join("\n")).not.toContain("Send from a subdomain");
    // A subdomain skips the guidance fetch entirely.
    expect(gets).toEqual([]);
    expect(posts).toEqual([{ domain: "notifications.mysite.com" }]);
  });

  it("still adds the root domain when the guidance fetch fails", async () => {
    const posts: unknown[] = [];
    const { ctx, captured } = makeCtx({
      argv: ["add", "mysite.com"],
      get: async () => {
        throw makeHttpError(500, { error: "boom" });
      },
      post: async (_path, body) => {
        posts.push(body);
        return STATUS_FIXTURE;
      },
    });
    await domainCommand.run(ctx);
    expect(captured.logs.join("\n")).not.toContain("Send from a subdomain");
    expect(posts).toEqual([{ domain: "mysite.com" }]);
  });
});
