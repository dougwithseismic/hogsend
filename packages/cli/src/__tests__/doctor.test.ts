import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { doctorCommand } from "../commands/doctor.js";
import type { CommandContext } from "../commands/types.js";
import { parseGlobalFlags, resolveConfig } from "../lib/config.js";
import { createAdminClient, createDataPlaneClient } from "../lib/http.js";
import type { Output } from "../lib/output.js";

/**
 * Doctor's config-warnings rendering and — critically — the DOUBLE-GATED
 * /v1/admin/config detail fetch. The CLI resolves the admin key ambiently
 * (env / cwd .env), so an unguarded fetch would transmit a full-admin bearer
 * token to whatever origin `--url` names. These tests assert on the ACTUAL
 * outgoing requests (a recorded global fetch), not on code paths:
 *
 *  - AC10: warning count + how-to-see-detail hint without a key
 *  - AC11: --admin-key lists each diagnostic's message, tagged by process
 *  - AC12: config warnings never flip the exit code
 *  - AC16: env-only key + explicit --url → NO Authorization header on the wire
 *  - AC17: no config block / zero warnings → /v1/admin/config never called
 */

interface RecordedRequest {
  path: string;
  origin: string;
  authorization: string | null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubServer(routes: Record<string, () => Response>): {
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    requests.push({
      path: url.pathname,
      origin: url.origin,
      authorization: headers.get("authorization"),
    });
    const route = routes[url.pathname];
    if (!route) return json({ error: "not found" }, 404);
    return route();
  }) as typeof fetch;
  vi.stubGlobal("fetch", fetchImpl);
  return { requests };
}

function healthBody(config?: { warnings: number }): Record<string, unknown> {
  return {
    status: "healthy",
    uptime: 42,
    timestamp: "2026-07-25T00:00:00.000Z",
    version: "0.56.0",
    components: {
      database: { status: "up", latencyMs: 2 },
      redis: { status: "up", latencyMs: 1 },
    },
    schema: {
      engine: { applied: "0004", required: "0004", inSync: true, pending: [] },
      client: { applied: "0002", required: "0002", inSync: true, pending: [] },
    },
    ...(config ? { config } : {}),
  };
}

const detailBody = {
  warnings: [
    {
      code: "email.no-provider",
      message: "No email provider configured; sends are inert",
      process: "api",
    },
    {
      code: "sms.no-sender",
      message: "Twilio credentials set without SMS_FROM",
      process: "worker",
    },
  ],
};

interface Harness {
  ctx: CommandContext;
  notes: Array<{ body: string; title?: string }>;
  jsonDocs: unknown[];
}

/** An empty cwd so no stray `.env` participates in config resolution. */
const emptyCwd = mkdtempSync(join(tmpdir(), "hogsend-doctor-test-"));

function makeCtx(argv: string[]): Harness {
  const flags = parseGlobalFlags(argv);
  const cfg = resolveConfig(flags, emptyCwd);
  const notes: Array<{ body: string; title?: string }> = [];
  const jsonDocs: unknown[] = [];
  const out: Output = {
    interactive: false,
    isJson: flags.json,
    intro() {},
    step: (_label, fn) => fn(),
    note(body, title) {
      notes.push({ body, title });
    },
    table() {},
    kv() {},
    log() {},
    json(payload) {
      jsonDocs.push(payload);
    },
    outro() {},
    fail(message): never {
      throw new Error(message);
    },
  };
  const ctx: CommandContext = {
    argv: flags.rest,
    cfg,
    http: createAdminClient(cfg),
    dataHttp: createDataPlaneClient(cfg),
    out,
    json: flags.json,
  };
  return { ctx, notes, jsonDocs };
}

describe("doctor config warnings", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Deterministic env: no ambient keys unless a test sets one, and a fixed
    // configured base URL (the "ambient target").
    vi.stubEnv("HOGSEND_ADMIN_KEY", "");
    vi.stubEnv("ADMIN_API_KEY", "");
    vi.stubEnv("HOGSEND_API_URL", "http://configured.internal:3002");
    vi.stubEnv("POSTHOG_API_KEY", "");
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never) as ReturnType<typeof vi.spyOn>;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    exitSpy.mockRestore();
  });

  it("AC10: prints the count and how to see detail when no admin key resolves", async () => {
    const { requests } = stubServer({
      "/v1/health": () => json(healthBody({ warnings: 2 })),
    });
    const { ctx, notes } = makeCtx([]);

    await doctorCommand.run(ctx);

    const rendered = notes.map((n) => n.body).join("\n");
    expect(rendered).toContain("2 warnings");
    expect(rendered).toContain("--admin-key");
    expect(requests.map((r) => r.path)).toEqual(["/v1/health"]);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("AC11: --admin-key lists each diagnostic's message tagged by process", async () => {
    const { requests } = stubServer({
      "/v1/health": () => json(healthBody({ warnings: 2 })),
      "/v1/admin/config": () => json(detailBody),
    });
    const { ctx, notes } = makeCtx(["--admin-key", "flag-secret"]);

    await doctorCommand.run(ctx);

    const rendered = notes.map((n) => n.body).join("\n");
    expect(rendered).toContain("No email provider configured; sends are inert");
    expect(rendered).toContain("Twilio credentials set without SMS_FROM");
    expect(rendered).toContain("[api]");
    expect(rendered).toContain("[worker]");
    const adminReq = requests.find((r) => r.path === "/v1/admin/config");
    expect(adminReq?.authorization).toBe("Bearer flag-secret");
  });

  it("AC12: config warnings alone leave the exit code at 0", async () => {
    stubServer({
      "/v1/health": () => json(healthBody({ warnings: 5 })),
      "/v1/admin/config": () => json(detailBody),
    });
    const { ctx } = makeCtx(["--admin-key", "flag-secret"]);

    await expect(doctorCommand.run(ctx)).resolves.toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("AC16: an env-only admin key is never transmitted to an explicit --url target", async () => {
    vi.stubEnv("HOGSEND_ADMIN_KEY", "env-secret");
    const { requests } = stubServer({
      "/v1/health": () => json(healthBody({ warnings: 3 })),
      "/v1/admin/config": () => json(detailBody),
    });
    const { ctx, notes } = makeCtx(["--url", "http://other.example:4000"]);

    await doctorCommand.run(ctx);

    // The count still renders — only the detail (and the key) is withheld.
    expect(notes.map((n) => n.body).join("\n")).toContain("3 warnings");
    // Assert on the wire: no request carried ANY Authorization header, and the
    // admin route was never called.
    expect(requests.length).toBeGreaterThan(0);
    for (const req of requests) {
      expect(req.authorization).toBeNull();
    }
    expect(requests.map((r) => r.path)).not.toContain("/v1/admin/config");
  });

  it("sends an env-derived key when the target is the ambient (non---url) base URL", async () => {
    vi.stubEnv("HOGSEND_ADMIN_KEY", "env-secret");
    const { requests } = stubServer({
      "/v1/health": () => json(healthBody({ warnings: 2 })),
      "/v1/admin/config": () => json(detailBody),
    });
    const { ctx } = makeCtx([]);

    await doctorCommand.run(ctx);

    const adminReq = requests.find((r) => r.path === "/v1/admin/config");
    expect(adminReq?.authorization).toBe("Bearer env-secret");
    expect(adminReq?.origin).toBe("http://configured.internal:3002");
  });

  it("an explicit --admin-key flag authorizes the detail fetch even with --url", async () => {
    const { requests } = stubServer({
      "/v1/health": () => json(healthBody({ warnings: 2 })),
      "/v1/admin/config": () => json(detailBody),
    });
    const { ctx } = makeCtx([
      "--url",
      "http://other.example:4000",
      "--admin-key",
      "typed-for-this-invocation",
    ]);

    await doctorCommand.run(ctx);

    const adminReq = requests.find((r) => r.path === "/v1/admin/config");
    expect(adminReq?.authorization).toBe("Bearer typed-for-this-invocation");
  });

  it("AC17: no config block (older engine) → /v1/admin/config is never called", async () => {
    const { requests } = stubServer({
      "/v1/health": () => json(healthBody()),
      "/v1/admin/config": () => json(detailBody),
    });
    // Explicit key on purpose: proves the gate is the config block, not a
    // missing key.
    const { ctx, notes } = makeCtx(["--admin-key", "flag-secret"]);

    await doctorCommand.run(ctx);

    expect(requests.map((r) => r.path)).toEqual(["/v1/health"]);
    expect(notes.map((n) => n.body).join("\n")).not.toContain("Config");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("AC17: config.warnings 0 → /v1/admin/config is never called", async () => {
    const { requests } = stubServer({
      "/v1/health": () => json(healthBody({ warnings: 0 })),
      "/v1/admin/config": () => json(detailBody),
    });
    const { ctx, notes } = makeCtx(["--admin-key", "flag-secret"]);

    await doctorCommand.run(ctx);

    expect(requests.map((r) => r.path)).toEqual(["/v1/health"]);
    expect(notes.map((n) => n.body).join("\n")).toContain("no warnings");
  });

  it("--json carries the warning count and, when fetched, the detail array", async () => {
    stubServer({
      "/v1/health": () => json(healthBody({ warnings: 2 })),
      "/v1/admin/config": () => json(detailBody),
    });
    const { ctx, jsonDocs } = makeCtx(["--json", "--admin-key", "flag-secret"]);

    await doctorCommand.run(ctx);

    expect(jsonDocs).toHaveLength(1);
    expect(jsonDocs[0]).toMatchObject({
      ok: true,
      config: { warnings: 2, detail: detailBody.warnings },
    });
  });

  it("--json against an older engine (no config block) omits config", async () => {
    stubServer({
      "/v1/health": () => json(healthBody()),
    });
    const { ctx, jsonDocs } = makeCtx(["--json"]);

    await doctorCommand.run(ctx);

    expect(jsonDocs).toHaveLength(1);
    expect((jsonDocs[0] as { config?: unknown }).config).toBeUndefined();
  });
});
