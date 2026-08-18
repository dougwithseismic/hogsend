import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialsPath, readCloudCredential } from "@hogsend/cli/cloud";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLOUD_TOOL_NAMES, registerCloudTools } from "../cloud-tools.js";
import { createHogsendMcpServer } from "../server.js";
import {
  createCloudBuildStatusTool,
  createCloudPublishTool,
  createCloudSignupTool,
  createCloudVerifyTool,
  createCloudWhoamiTool,
  derivePhase,
} from "../tools/cloud.js";
import { makeClient } from "./helpers.js";

/**
 * The `cloud_*` tools (PRD 18), against a scripted control plane, a temp HOME
 * and a real temp scaffold.
 *
 * Three properties are asserted harder than the rest, because each is the kind
 * that fails silently:
 *  - THE TOKEN NEVER CROSSES THE WIRE. Checked against the SERIALIZED tool
 *    result — the actual bytes an MCP host records — not against the object,
 *    because a field that stringifies is a field that leaks.
 *  - THE SESSION IS THE CLI'S. `cloud_verify` must leave a credential the
 *    `hogsend` CLI reads, so the two are interchangeable; asserted by reading
 *    it back through the CLI's own reader.
 *  - THE HOSTED SERVER HAS NONE OF THIS. Asserted from the outside, by listing
 *    a hosted-shaped server's tools.
 */

const CLOUD = "http://localhost:3996";
const TOKEN = "hscli_mcp_secret_never_on_the_wire";
const ENV_ID = "44444444-4444-4444-8444-444444444444";
const BUILD_ID = "55555555-5555-4555-8555-555555555555";

let home = "";
let realFetch: typeof globalThis.fetch;
let calls: { path: string; body: unknown }[] = [];

interface Answer {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

function scriptCloud(overrides: Record<string, Answer> = {}): void {
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input instanceof Request ? input.url : input);
    const path = url.slice(CLOUD.length);
    const raw = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ path, body: raw ? JSON.parse(raw) : undefined });

    const answer =
      overrides[path] ??
      (path === "/api/cli/signup"
        ? { status: 200, body: { status: "sent", expiresInSeconds: 600 } }
        : path === "/api/cli/signup/verify"
          ? {
              status: 200,
              body: {
                status: "ok",
                created: { user: true, organization: true },
                token: TOKEN,
                sessionId: "session-1",
                userId: "user-1",
                organizationId: "org-1",
                environmentId: ENV_ID,
                note: null,
              },
            }
          : path === "/api/cli/session"
            ? {
                status: 200,
                body: {
                  user: { id: "user-1", email: "me@acme.test", name: "Me" },
                  organization: { id: "org-1", name: "Acme", slug: "acme" },
                  role: "owner",
                },
              }
            : path === "/api/cli/environments"
              ? {
                  status: 200,
                  body: {
                    organization: { id: "org-1", name: "Acme" },
                    environments: [
                      {
                        id: ENV_ID,
                        name: "production",
                        kind: "production",
                        stackStatus: "deferred",
                        engineVersion: null,
                      },
                    ],
                  },
                }
              : path === `/api/publish/${ENV_ID}`
                ? { status: 202, body: { buildId: BUILD_ID, status: "queued" } }
                : {
                    status: 404,
                    body: { error: "not_found", message: "no" },
                  });

    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: {
        "content-type": "application/json",
        ...(answer.headers ?? {}),
      },
    });
  }) as typeof globalThis.fetch;
}

/** A minimal but REAL scaffold — publish resolves the root from a package.json. */
function makeScaffold(): string {
  const dir = mkdtempSync(join(tmpdir(), "hogsend-mcp-app-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "acme-lifecycle",
      dependencies: { "@hogsend/engine": "0.62.0" },
    }),
  );
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "index.ts"), "export {};\n");
  return dir;
}

/** Sign in the way a previous `cloud_verify` (or the CLI) would have. */
function signIn(): void {
  const file = credentialsPath(home);
  mkdirSync(join(home, ".hogsend"), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      clouds: {
        "localhost:3996": {
          token: TOKEN,
          createdAt: new Date().toISOString(),
        },
      },
    }),
  );
}

beforeEach(() => {
  realFetch = globalThis.fetch;
  calls = [];
  home = mkdtempSync(join(tmpdir(), "hogsend-mcp-home-"));
  process.env.HOME = home;
  scriptCloud();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("cloud_signup", () => {
  it("mails a code and hands back the email as the pending handle", async () => {
    const tool = createCloudSignupTool();
    const result = (await tool.handler({
      email: "Me@Acme.test",
      cloudUrl: CLOUD,
    })) as Record<string, unknown>;

    expect(result.ok).toBe(true);
    expect(result.status).toBe("sent");
    // Lowercased before it leaves: the cloud's per-email rate limit keys on the
    // string, and one inbox must not be two budgets.
    expect(result.email).toBe("me@acme.test");
    expect(calls[0]).toEqual({
      path: "/api/cli/signup",
      body: { email: "me@acme.test" },
    });
    // The agent is told what to call next, by TOOL name.
    expect(String(result.next)).toContain("cloud_verify");
  });

  it("maps a rate limit to a structured code with the seconds", async () => {
    scriptCloud({
      "/api/cli/signup": {
        status: 429,
        body: { error: "rate_limited", message: "Too many codes requested." },
        headers: { "retry-after": "42" },
      },
    });

    const result = (await createCloudSignupTool().handler({
      email: "me@acme.test",
      cloudUrl: CLOUD,
    })) as Record<string, unknown>;

    expect(result.ok).toBe(false);
    expect(result.code).toBe("rate_limited");
    expect(result.retryAfterSeconds).toBe(42);
  });
});

describe("cloud_verify", () => {
  it("stores a session the CLI can use, and NEVER returns the token", async () => {
    const result = await createCloudVerifyTool().handler({
      email: "me@acme.test",
      otp: "123456",
      cloudUrl: CLOUD,
    });

    const body = result as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.created).toEqual({ user: true, organization: true });
    expect(body.organizationId).toBe("org-1");

    // THE assertion: against the SERIALIZED result, which is what an MCP host
    // puts in its transcript. Checking the object's fields would miss a token
    // hiding in a nested value.
    expect(JSON.stringify(result)).not.toContain(TOKEN);

    // ...and it really did land, in the CLI's own store, read back through the
    // CLI's own reader. This is what makes CLI and MCP sessions interchangeable.
    const stored = readCloudCredential("localhost:3996", home);
    expect(stored?.token).toBe(TOKEN);
    // Read as the CLI's `whoami` path would: same host key, same file.
    expect(readFileSync(credentialsPath(home), "utf8")).toContain(TOKEN);
  });

  it("maps a wrong code to invalid_code and stores nothing", async () => {
    scriptCloud({
      "/api/cli/signup/verify": {
        status: 401,
        body: { error: "invalid_code", message: "That code is not right." },
      },
    });

    const result = (await createCloudVerifyTool().handler({
      email: "me@acme.test",
      otp: "000000",
      cloudUrl: CLOUD,
    })) as Record<string, unknown>;

    expect(result.ok).toBe(false);
    expect(result.code).toBe("invalid_code");
    expect(String(result.hint)).toContain("cloud_verify");
    expect(readCloudCredential("localhost:3996", home)).toBeUndefined();
  });

  it("does NOT re-send the code — a second send would rotate it server-side", async () => {
    // THE regression this file exists for. `cloud_verify` originally reused
    // the CLI's whole send-then-verify flow, which mails a FRESH code before
    // checking the one it was given — so the control plane rotated the code
    // the agent was holding and the verify could never succeed. Caught by
    // driving the real tools against a real control plane, not here; this is
    // the assertion that keeps it caught.
    await createCloudVerifyTool().handler({
      email: "me@acme.test",
      otp: "123456",
      cloudUrl: CLOUD,
    });

    const paths = calls.map((c) => c.path);
    // The verify itself, then the label lookup `storeCloudLogin` does. What
    // must NOT be there is a second SEND.
    expect(paths).toEqual(["/api/cli/signup/verify", "/api/cli/session"]);
    expect(paths).not.toContain("/api/cli/signup");
  });

  it("asks the cloud ONCE — an agent's code does not improve by resubmitting", async () => {
    scriptCloud({
      "/api/cli/signup/verify": {
        status: 401,
        body: { error: "invalid_code", message: "That code is not right." },
      },
    });

    await createCloudVerifyTool().handler({
      email: "me@acme.test",
      otp: "000000",
      cloudUrl: CLOUD,
    });

    expect(
      calls.filter((c) => c.path === "/api/cli/signup/verify"),
    ).toHaveLength(1);
  });
});

describe("cloud_whoami", () => {
  it("names the user, the org and what can be deployed to", async () => {
    signIn();
    const result = (await createCloudWhoamiTool().handler({
      cloudUrl: CLOUD,
    })) as Record<string, unknown>;

    expect(result.ok).toBe(true);
    expect((result.user as { email: string }).email).toBe("me@acme.test");
    expect(result.role).toBe("owner");
    expect(result.environments).toEqual([
      {
        id: ENV_ID,
        name: "production",
        kind: "production",
        stackStatus: "deferred",
        engineVersion: null,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("returns needs_auth naming cloud_signup when nothing is stored", async () => {
    const result = (await createCloudWhoamiTool().handler({
      cloudUrl: CLOUD,
    })) as Record<string, unknown>;

    expect(result.ok).toBe(false);
    expect(result.code).toBe("needs_auth");
    // The next move as a TOOL, because an agent holding these cannot run a
    // shell command — telling it to "run hogsend signup" would be useless.
    expect(String(result.hint)).toContain("cloud_signup");
    expect(calls).toEqual([]);
  });
});

describe("cloud_publish", () => {
  it("uploads the scaffold and returns the build id immediately", async () => {
    signIn();
    const dir = makeScaffold();

    const result = (await createCloudPublishTool().handler({
      cwd: dir,
      cloudUrl: CLOUD,
    })) as Record<string, unknown>;

    expect(result.ok).toBe(true);
    expect(result.buildId).toBe(BUILD_ID);
    expect(result.status).toBe("queued");
    // It returned rather than watching: no build was polled.
    expect(calls.map((c) => c.path)).not.toContain(`/api/builds/${BUILD_ID}`);
    expect(String(result.next)).toContain("cloud_build_status");
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("refuses with needs_auth before packing anything", async () => {
    const dir = makeScaffold();
    const result = (await createCloudPublishTool().handler({
      cwd: dir,
      cloudUrl: CLOUD,
    })) as Record<string, unknown>;

    expect(result.ok).toBe(false);
    expect(result.code).toBe("needs_auth");
    expect(String(result.hint)).toContain("cloud_signup");
    // Nothing was uploaded, and nothing was even asked.
    expect(calls).toEqual([]);
  });

  it("says not_a_scaffold for a directory that is not one", async () => {
    signIn();
    const empty = mkdtempSync(join(tmpdir(), "hogsend-not-app-"));

    const result = (await createCloudPublishTool().handler({
      cwd: empty,
      cloudUrl: CLOUD,
    })) as Record<string, unknown>;

    expect(result.ok).toBe(false);
    expect(result.code).toBe("not_a_scaffold");
    expect(String(result.hint)).toContain("create-hogsend");
  });

  it("refuses an engine mismatch before uploading, and names the flag", async () => {
    signIn();
    const dir = makeScaffold();
    scriptCloud({
      "/api/cli/environments": {
        status: 200,
        body: {
          organization: { id: "org-1", name: "Acme" },
          environments: [
            {
              id: ENV_ID,
              name: "production",
              kind: "production",
              stackStatus: "running",
              // The stack runs something else entirely.
              engineVersion: "0.50.0",
            },
          ],
        },
      },
    });

    const result = (await createCloudPublishTool().handler({
      cwd: dir,
      cloudUrl: CLOUD,
    })) as Record<string, unknown>;

    expect(result.ok).toBe(false);
    expect(result.code).toBe("engine_version_mismatch");
    expect(String(result.hint)).toContain("allowUpgrade");
    expect(calls.map((c) => c.path)).not.toContain(`/api/publish/${ENV_ID}`);
  });

  it("names what exists when --env matches nothing", async () => {
    signIn();
    const dir = makeScaffold();

    const result = (await createCloudPublishTool().handler({
      cwd: dir,
      env: "staging",
      cloudUrl: CLOUD,
    })) as Record<string, unknown>;

    expect(result.ok).toBe(false);
    expect(result.code).toBe("no_environment");
    expect(String(result.hint)).toContain("production");
  });
});

describe("cloud_build_status", () => {
  const build = (over: Record<string, unknown>) => ({
    status: 200,
    body: {
      id: BUILD_ID,
      environmentId: ENV_ID,
      status: "queued",
      terminal: false,
      engineVersion: "0.62.0",
      imageDigest: null,
      error: null,
      logTail: null,
      ...over,
    },
  });

  it("reports provisioning separately from building", async () => {
    signIn();
    scriptCloud({
      [`/api/builds/${BUILD_ID}`]: build({
        status: "building",
        stack: { status: "provisioning" },
      }),
    });

    const result = (await createCloudBuildStatusTool().handler({
      buildId: BUILD_ID,
      cloudUrl: CLOUD,
    })) as Record<string, unknown>;

    expect(result.ok).toBe(true);
    // The build says `building`, but it is WAITING — reporting that verbatim
    // would have an agent believing compilation had begun.
    expect(result.phase).toBe("provisioning");
    expect(result.terminal).toBe(false);
    expect(String(result.narrative)).toContain("database");
    expect(result.stack).toEqual({ status: "provisioning" });
  });

  it("moves to building once the instance is up, then to succeeded", async () => {
    signIn();
    scriptCloud({
      [`/api/builds/${BUILD_ID}`]: build({
        status: "pushing",
        stack: { status: "running" },
      }),
    });
    const mid = (await createCloudBuildStatusTool().handler({
      buildId: BUILD_ID,
      cloudUrl: CLOUD,
    })) as Record<string, unknown>;
    expect(mid.phase).toBe("building");

    scriptCloud({
      [`/api/builds/${BUILD_ID}`]: build({
        status: "succeeded",
        terminal: true,
        stack: { status: "running" },
        imageDigest: "sha256:abc",
      }),
    });
    const done = (await createCloudBuildStatusTool().handler({
      buildId: BUILD_ID,
      cloudUrl: CLOUD,
    })) as Record<string, unknown>;
    expect(done.phase).toBe("succeeded");
    expect(done.terminal).toBe(true);
  });

  it("calls a parked stack a failure rather than a slow build", () => {
    // Pure, so every combination is cheap to state.
    expect(
      derivePhase({
        status: "building",
        terminal: false,
        stack: { status: "error" },
      }).phase,
    ).toBe("failed");
    expect(
      derivePhase({ status: "failed", terminal: true, stack: null }).phase,
    ).toBe("failed");
    // A cloud that sends no stack field at all (older control plane) still
    // reports a coherent build phase.
    expect(derivePhase({ status: "building", terminal: false }).phase).toBe(
      "building",
    );
  });

  it("maps an unknown build to not_found", async () => {
    signIn();
    scriptCloud({
      [`/api/builds/${BUILD_ID}`]: {
        status: 404,
        body: { error: "build_not_found", message: "No such build." },
      },
    });

    const result = (await createCloudBuildStatusTool().handler({
      buildId: BUILD_ID,
      cloudUrl: CLOUD,
    })) as Record<string, unknown>;

    expect(result.ok).toBe(false);
    expect(result.code).toBe("not_found");
  });
});

describe("registration", () => {
  async function listTools(register: boolean): Promise<string[]> {
    const { client: admin } = makeClient({});
    const server = createHogsendMcpServer({ client: admin });
    if (register) registerCloudTools(server);

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const { tools } = await client.listTools();
    await client.close();
    await server.close();
    return tools.map((t) => t.name).sort();
  }

  it("registers exactly the five cloud tools on the stdio server", async () => {
    const names = await listTools(true);
    for (const name of CLOUD_TOOL_NAMES) expect(names).toContain(name);
    // The instance tools are still there — the two sets coexist.
    expect(names).toContain("manage_blueprint");
    expect(names).toHaveLength(CLOUD_TOOL_NAMES.length + 5);
  });

  it("registers NONE of them on a hosted-shaped server", async () => {
    // The hosted transport builds its server with `createHogsendMcpServer`
    // alone and never imports `registerCloudTools` — this is that server.
    const names = await listTools(false);
    for (const name of CLOUD_TOOL_NAMES) expect(names).not.toContain(name);
    expect(names).toEqual([
      "get_referral_report",
      "get_referral_tree",
      "hogsend_report",
      "manage_blueprint",
      "send_test_email",
    ]);
  });

  it("keeps the hosted route free of the cloud tools by IMPORT, not by a flag", async () => {
    // The strongest available statement of the rule: a flag can be passed
    // wrongly, an absent import cannot. If `routes.ts` ever reaches for these,
    // this fails — and it fails at the seam that would put an operator's
    // credentials file on a tenant's shared server.
    const routes = readFileSync(
      new URL("../routes.ts", import.meta.url),
      "utf8",
    );
    expect(routes).not.toContain("cloud-tools");
    expect(routes).not.toContain("registerCloudTools");
  });

  it("serves the cloud tools with no admin key at all", async () => {
    // The scaffold → signup → publish story starts before any instance
    // exists, so the stdio server must be useful without HOGSEND_ADMIN_KEY.
    const server = createHogsendMcpServer({});
    registerCloudTools(server);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...CLOUD_TOOL_NAMES].sort());
    // The instance tools are absent rather than present-and-broken: a tool
    // that cannot work is worse than one that is not offered.
    expect(names).not.toContain("manage_blueprint");

    await client.close();
    await server.close();
  });
});
