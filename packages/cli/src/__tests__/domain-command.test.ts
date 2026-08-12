import type { DnsRecord, EngineDomainStatus } from "@hogsend/engine";
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

const DKIM_VERIFIED: DnsRecord = {
  type: "TXT",
  name: "resend._domainkey.mysite.com",
  value: "p=MIGfMA0GCSq",
  purpose: "dkim",
  status: "verified",
};

const RETURN_PATH_RECORDS: DnsRecord[] = [
  {
    type: "MX",
    name: "send.mysite.com",
    value: "feedback-smtp.us-east-1.amazonses.com",
    priority: 10,
    purpose: "mx",
    status: "pending",
  },
  {
    type: "TXT",
    name: "send.mysite.com",
    value: "v=spf1 include:amazonses.com ~all",
    purpose: "spf",
    status: "pending",
  },
];

/** What POST /v1/admin/domain/return-path answers after switching ON. */
const RETURN_PATH_ON_FIXTURE = {
  returnPath: { enabled: true, mailFromDomain: "send.mysite.com" },
  status: {
    ...STATUS_FIXTURE,
    providerId: "hogsend",
    returnPathSupported: true,
    status: {
      // biome-ignore lint/style/noNonNullAssertion: fixture literal above.
      ...STATUS_FIXTURE.status!,
      state: "verified" as const,
      records: [DKIM_VERIFIED, ...RETURN_PATH_RECORDS],
    },
  },
};

/** ... and after switching OFF: base records only, still fully verified. */
const RETURN_PATH_OFF_FIXTURE = {
  returnPath: { enabled: false, mailFromDomain: null },
  status: {
    ...STATUS_FIXTURE,
    providerId: "hogsend",
    returnPathSupported: true,
    status: {
      // biome-ignore lint/style/noNonNullAssertion: fixture literal above.
      ...STATUS_FIXTURE.status!,
      state: "verified" as const,
      records: [DKIM_VERIFIED],
    },
  },
};

interface CapturedOutput {
  logs: string[];
  jsonDocs: unknown[];
  tables: Record<string, unknown>[][];
  kvs: Record<string, unknown>[];
}

function makeCtx(opts: {
  argv: string[];
  json?: boolean;
  get?: (path: string, query?: Query) => Promise<unknown>;
  post?: (path: string, body: unknown) => Promise<unknown>;
}): { ctx: CommandContext; captured: CapturedOutput } {
  const captured: CapturedOutput = {
    logs: [],
    jsonDocs: [],
    tables: [],
    kvs: [],
  };

  const out: Output = {
    interactive: false,
    isJson: opts.json ?? false,
    intro: () => {},
    step: async <T>(_label: string, fn: () => Promise<T>) => fn(),
    note: (body: string, title?: string) => {
      captured.logs.push(title ? `${title}\n${body}` : body);
    },
    table: (rows: Record<string, unknown>[]) => {
      captured.tables.push(rows);
    },
    kv: (obj: Record<string, unknown>) => {
      captured.kvs.push(obj);
    },
    log: (msg: string) => {
      captured.logs.push(msg);
    },
    json: (payload: unknown) => {
      captured.jsonDocs.push(payload);
    },
    outro: (msg: string) => {
      captured.logs.push(msg);
    },
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

  it("fails on an unknown subcommand, listing return-path among the options", async () => {
    const { ctx } = makeCtx({ argv: ["frobnicate"] });
    await expect(domainCommand.run(ctx)).rejects.toThrow(
      /expected add \| check \| status \| return-path/,
    );
  });

  it("documents return-path in the usage text", async () => {
    const { ctx, captured } = makeCtx({ argv: ["--help"] });
    await domainCommand.run(ctx);
    const output = captured.logs.join("\n");
    expect(output).toContain("return-path on|off");
    expect(output).toContain("--label <label>");
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

// PRD 20 task 5 — `hogsend domain return-path on|off [--label]`. The CLI is
// not a second-class surface: it shows the same records and the same
// explanation Studio's Setup card renders.
describe("hogsend domain return-path", () => {
  it("on POSTs {enabled:true} and shows the two pending records + the explanation", async () => {
    const posts: Array<{ path: string; body: unknown }> = [];
    const { ctx, captured } = makeCtx({
      argv: ["return-path", "on"],
      post: async (path, body) => {
        posts.push({ path, body });
        return RETURN_PATH_ON_FIXTURE;
      },
    });
    await domainCommand.run(ctx);

    expect(posts).toEqual([
      { path: "/v1/admin/domain/return-path", body: { enabled: true } },
    ]);

    // The MX + SPF pair renders as pending, alongside the verified DKIM row.
    const table = captured.tables.at(-1) ?? [];
    const byPurpose = new Map(table.map((row) => [row.purpose, row]));
    expect(byPurpose.get("mx")?.status).toBe("pending");
    expect(byPurpose.get("spf")?.status).toBe("pending");
    expect(byPurpose.get("dkim")?.status).toBe("verified");

    // The explanation: benefit in the customer's terms first, cost in the
    // same breath, mechanism second — the same words Studio renders.
    const output = captured.logs.join("\n");
    expect(output).toContain("via amazonses.com");
    expect(output).toContain("two more DNS records (MX and SPF)");
    expect(output).toContain("Bounce traffic");
    expect(output).toContain("bounce routing:");
    expect(output).toContain("send.mysite.com");
  });

  it("on --label sends the normalized label", async () => {
    const posts: unknown[] = [];
    const { ctx } = makeCtx({
      argv: ["return-path", "on", "--label", "NOTIFICATIONS"],
      post: async (_path, body) => {
        posts.push(body);
        return RETURN_PATH_ON_FIXTURE;
      },
    });
    await domainCommand.run(ctx);
    expect(posts).toEqual([{ enabled: true, label: "notifications" }]);
  });

  it("rejects an invalid label BY NAME, before any HTTP", async () => {
    const posts: unknown[] = [];
    const { ctx } = makeCtx({
      argv: ["return-path", "on", "--label", "no.dots"],
      post: async (_path, body) => {
        posts.push(body);
        return RETURN_PATH_ON_FIXTURE;
      },
    });
    await expect(domainCommand.run(ctx)).rejects.toThrow(/"no\.dots"/);
    expect(posts).toEqual([]);
  });

  it("off POSTs {enabled:false} and reports a verified, warning-free domain", async () => {
    const posts: unknown[] = [];
    const { ctx, captured } = makeCtx({
      argv: ["return-path", "off"],
      post: async (_path, body) => {
        posts.push(body);
        return RETURN_PATH_OFF_FIXTURE;
      },
    });
    await domainCommand.run(ctx);

    expect(posts).toEqual([{ enabled: false }]);
    // Off is not a warning state: the kv line reads off, the state stays
    // verified, and the live-sends tick still prints.
    expect(captured.kvs[0]?.returnPath).toBe("off");
    expect(captured.kvs[0]?.state).toBe("verified");
    expect(captured.logs.join("\n")).toContain("sends live");
    expect(captured.logs.join("\n")).not.toMatch(/warning|action required/i);
    // The MX + SPF records stop being shown once off.
    const purposes = (captured.tables.at(-1) ?? []).map((row) => row.purpose);
    expect(purposes).toEqual(["dkim"]);
  });

  it("refuses --label with off", async () => {
    const { ctx } = makeCtx({
      argv: ["return-path", "off", "--label", "send"],
    });
    await expect(domainCommand.run(ctx)).rejects.toThrow(
      /--label only applies/,
    );
  });

  it("fails with an explanation when the direction is missing", async () => {
    const { ctx } = makeCtx({ argv: ["return-path"] });
    await expect(domainCommand.run(ctx)).rejects.toThrow(/expected on or off/);
  });

  it("exits with an explanation on a 501 (capability absent)", async () => {
    const { ctx } = makeCtx({
      argv: ["return-path", "on"],
      post: async () => {
        throw makeHttpError(501, { error: "provider_unsupported" });
      },
      // The command resolves the provider id for the message via GET.
      get: async () => ({ ...STATUS_FIXTURE, providerId: "postmark" }),
    });
    await expect(domainCommand.run(ctx)).rejects.toThrow(
      /provider postmark cannot switch the return path/,
    );
  });

  it("fails with the no-domain explanation on 400 no_domain_configured", async () => {
    const { ctx } = makeCtx({
      argv: ["return-path", "on"],
      post: async () => {
        throw makeHttpError(400, { error: "no_domain_configured" });
      },
    });
    await expect(domainCommand.run(ctx)).rejects.toThrow(
      /no sending domain configured/,
    );
  });

  it("--json emits the switch result as a single parseable document", async () => {
    const { ctx, captured } = makeCtx({
      argv: ["return-path", "on"],
      json: true,
      post: async () => RETURN_PATH_ON_FIXTURE,
    });
    await domainCommand.run(ctx);
    expect(captured.jsonDocs).toHaveLength(1);
    expect(JSON.parse(JSON.stringify(captured.jsonDocs[0]))).toEqual(
      RETURN_PATH_ON_FIXTURE,
    );
  });

  describe("copy law: the return path carries bounces", () => {
    // The misunderstanding PRD 20 exists to correct is "the return path
    // brings customer answers back". No string this subcommand prints may
    // contain the substring that starts that sentence.
    const FORBIDDEN = /repl/i;

    it("nothing the on/off/help runs print contains it", async () => {
      const outputs: string[] = [];

      for (const [argv, fixture] of [
        [["return-path", "on"], RETURN_PATH_ON_FIXTURE],
        [["return-path", "off"], RETURN_PATH_OFF_FIXTURE],
      ] as const) {
        const { ctx, captured } = makeCtx({
          argv: [...argv],
          post: async () => fixture,
        });
        await domainCommand.run(ctx);
        outputs.push(captured.logs.join("\n"));
      }

      const help = makeCtx({ argv: ["--help"] });
      await domainCommand.run(help.ctx);
      outputs.push(help.captured.logs.join("\n"));

      expect(outputs.join("\n")).not.toMatch(FORBIDDEN);
    });

    it("neither do the refusal messages", async () => {
      const label = makeCtx({
        argv: ["return-path", "on", "--label", "no.dots"],
      });
      const labelErr = await domainCommand
        .run(label.ctx)
        .catch((err: Error) => err.message);
      const unsupported = makeCtx({
        argv: ["return-path", "on"],
        post: async () => {
          throw makeHttpError(501, { error: "provider_unsupported" });
        },
        get: async () => STATUS_FIXTURE,
      });
      const unsupportedErr = await domainCommand
        .run(unsupported.ctx)
        .catch((err: Error) => err.message);

      expect(String(labelErr)).not.toMatch(FORBIDDEN);
      expect(String(unsupportedErr)).not.toMatch(FORBIDDEN);
    });
  });
});
