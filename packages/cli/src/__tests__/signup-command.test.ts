import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loginCommand } from "../commands/login.js";
import { runEmailLoginCommand, signupCommand } from "../commands/signup.js";
import type { CommandContext } from "../commands/types.js";
import { credentialsPath } from "../lib/credentials.js";
import type { Output } from "../lib/output.js";

/**
 * `hogsend signup` and `hogsend login --email`, driven through the REAL
 * commands against a scripted cloud and a temp HOME.
 *
 * What this proves that `email-login.test.ts` cannot: the wiring. That the
 * credential is written — at 0600, with the token the cloud minted — that the
 * summary tells the truth about whether an account was created, that a refusal
 * exits nonzero with an instruction rather than a stack trace, and the rule
 * with no exceptions: THE TOKEN IS NEVER IN THE SCROLLBACK, in any mode,
 * including the failure ones.
 */

const CLOUD = "http://localhost:3998";
const TOKEN = "hscli_command_test_secret";

class FailSignal extends Error {
  constructor(readonly failMessage: string) {
    super(failMessage);
    this.name = "FailSignal";
  }
}

let home = "";
let realFetch: typeof globalThis.fetch;
let calls: { path: string; body: unknown }[] = [];

interface Captured {
  lines: string[];
  docs: unknown[];
  /** logs + json + stderr + the fail message. Everything a human could see. */
  all(): string;
}

function makeCtx(
  argv: string[],
  options: { json?: boolean; interactive?: boolean } = {},
): { ctx: CommandContext; captured: Captured } {
  const json = options.json ?? false;
  const lines: string[] = [];
  const docs: unknown[] = [];
  let failed = "";

  const out: Output = {
    isJson: json,
    // Non-interactive by default: a test suite has no terminal, and the code
    // therefore arrives the way CI supplies it.
    interactive: options.interactive ?? false,
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

interface CloudScript {
  send?: { status: number; body: unknown; headers?: Record<string, string> };
  verify?: { status: number; body: unknown; headers?: Record<string, string> };
  /** `GET /api/cli/session`, the label lookup after the credential is stored. */
  session?: { status: number; body: unknown };
}

const VERIFIED = {
  status: 200,
  body: {
    status: "ok",
    created: { user: true, organization: true },
    token: TOKEN,
    sessionId: "session-1",
    userId: "user-1",
    organizationId: "org-1",
    environmentId: "env-1",
    note: null,
  },
};

function scriptCloud(script: CloudScript = {}): void {
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input instanceof Request ? input.url : input);
    const path = url.slice(CLOUD.length);
    const raw = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ path, body: raw ? JSON.parse(raw) : undefined });

    const answer =
      path === "/api/cli/signup"
        ? (script.send ?? {
            status: 200,
            body: { status: "sent", expiresInSeconds: 600 },
          })
        : path === "/api/cli/signup/verify"
          ? (script.verify ?? VERIFIED)
          : path === "/api/cli/session"
            ? (script.session ?? {
                status: 200,
                body: {
                  user: { email: "someone@acme.test" },
                  organization: { name: "Acme Rockets" },
                },
              })
            : { status: 404, body: { error: "not_found", message: "no" } };

    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: {
        "content-type": "application/json",
        ...("headers" in answer ? (answer.headers ?? {}) : {}),
      },
    });
  }) as typeof globalThis.fetch;
}

/** The code, as a piped run supplies it. Never a real stdin. */
const pipe = (code: string) => ({ readLine: async () => code });

beforeEach(() => {
  realFetch = globalThis.fetch;
  calls = [];
  home = mkdtempSync(join(tmpdir(), "hogsend-signup-home-"));
  process.env.HOME = home;
  scriptCloud();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function storedCredential(): { token?: string; userLabel?: string } {
  const file = credentialsPath(home);
  const parsed = JSON.parse(readFileSync(file, "utf8")) as {
    clouds: Record<string, { token: string; userLabel?: string }>;
  };
  return parsed.clouds["localhost:3998"] ?? {};
}

describe("hogsend signup", () => {
  it("writes the session at 0600 and welcomes a new account", async () => {
    const { ctx, captured } = makeCtx([]);

    await runEmailLoginCommand(
      ctx,
      { email: "Someone@Acme.test", cloud: CLOUD, org: "Acme Rockets" },
      { verb: "signup", badge: "signup" },
      pipe("123456"),
    );

    // The credential the cloud minted, on disk, readable by nobody else.
    expect(storedCredential().token).toBe(TOKEN);
    expect(storedCredential().userLabel).toBe("someone@acme.test");
    expect(statSync(credentialsPath(home)).mode & 0o777).toBe(0o600);

    // The address is normalised before it leaves: `Someone@` and `someone@`
    // are one inbox, and the cloud's per-email rate limit keys on the string.
    const send = calls.find((c) => c.path === "/api/cli/signup");
    expect(send?.body).toEqual({ email: "someone@acme.test" });

    const printed = captured.all();
    expect(printed).toContain("Welcome to Hogsend");
    expect(printed).toContain("someone@acme.test");
    expect(printed).toContain("Acme Rockets");
    // The new tenant is told, in the summary, that nothing is running yet —
    // otherwise a `deferred` stack reads as a broken signup.
    expect(printed).toContain("built on your first publish");
    // THE rule.
    expect(printed).not.toContain(TOKEN);
  });

  it("says welcome BACK to a returning user, and names the ignored --org", async () => {
    scriptCloud({
      verify: {
        status: 200,
        body: {
          ...VERIFIED.body,
          created: { user: false, organization: false },
          note: "org_ignored_existing",
        },
      },
    });
    const { ctx, captured } = makeCtx([]);

    await runEmailLoginCommand(
      ctx,
      { email: "someone@acme.test", cloud: CLOUD, org: "A Second Company" },
      { verb: "signup", badge: "signup" },
      pipe("123456"),
    );

    const printed = captured.all();
    expect(printed).toContain("Welcome back");
    expect(printed).not.toContain("Welcome to Hogsend");
    // Named rather than silently dropped, so nobody wonders where their
    // second organization went.
    expect(printed).toContain("--org was ignored");
    expect(printed).not.toContain("built on your first publish");
    expect(printed).not.toContain(TOKEN);
  });

  it("emits ONE json document, carrying no token", async () => {
    const { ctx, captured } = makeCtx([], { json: true });

    await runEmailLoginCommand(
      ctx,
      { email: "someone@acme.test", cloud: CLOUD },
      { verb: "signup", badge: "signup" },
      pipe("123456"),
    );

    expect(captured.docs).toHaveLength(1);
    const doc = captured.docs[0] as Record<string, unknown>;
    expect(doc.signedIn).toBe(true);
    expect(doc.created).toEqual({ user: true, organization: true });
    expect(doc.environmentId).toBe("env-1");
    expect(doc.organizationId).toBe("org-1");
    // Machine-readable, and machine-readable does not mean "everything".
    expect(Object.values(doc)).not.toContain(TOKEN);
    expect(JSON.stringify(doc)).not.toContain(TOKEN);
    // It is still on disk — the CLI has the session, it just did not print it.
    expect(storedCredential().token).toBe(TOKEN);
  });

  it("refuses without prompting when there is no terminal and no --email", async () => {
    const { ctx, captured } = makeCtx(["--cloud", CLOUD]);

    await expect(signupCommand.run(ctx)).rejects.toBeInstanceOf(FailSignal);

    // The exact flag to pass, not "email is required": a CI job that hung on
    // a prompt would burn its whole timeout instead of failing in a second.
    expect(captured.all()).toContain("hogsend signup --email you@example.com");
    // And it refused BEFORE reaching the cloud.
    expect(calls).toEqual([]);
  });

  it("refuses an address that is not one, without a round trip", async () => {
    const { ctx, captured } = makeCtx([
      "--email",
      "not-an-email",
      "--cloud",
      CLOUD,
    ]);

    await expect(signupCommand.run(ctx)).rejects.toBeInstanceOf(FailSignal);
    expect(captured.all()).toContain("is not an email address");
    expect(calls).toEqual([]);
  });

  it("renders a wrong code as an instruction, and stores nothing", async () => {
    scriptCloud({
      verify: {
        status: 401,
        body: { error: "invalid_code", message: "That code is not right." },
      },
    });
    const { ctx, captured } = makeCtx([]);

    await expect(
      runEmailLoginCommand(
        ctx,
        { email: "someone@acme.test", cloud: CLOUD },
        { verb: "signup", badge: "signup" },
        pipe("000000"),
      ),
    ).rejects.toBeInstanceOf(FailSignal);

    expect(captured.all()).toContain("Check the code in your inbox");
    // A refused verify leaves no credential behind.
    expect(() => readFileSync(credentialsPath(home), "utf8")).toThrow();
  });

  it("renders a rate limit with the seconds the cloud asked for", async () => {
    scriptCloud({
      send: {
        status: 429,
        body: { error: "rate_limited", message: "Too many codes requested." },
        headers: { "retry-after": "42" },
      },
    });
    const { ctx, captured } = makeCtx([]);

    await expect(
      runEmailLoginCommand(
        ctx,
        { email: "someone@acme.test", cloud: CLOUD },
        { verb: "signup", badge: "signup" },
        pipe("123456"),
      ),
    ).rejects.toBeInstanceOf(FailSignal);

    // The number, not "try again later": a human deciding whether to wait
    // needs to know it is 42 seconds and not an hour.
    expect(captured.all()).toContain("42s");
  });

  it("keeps the session when the label lookup fails", async () => {
    scriptCloud({ session: { status: 500, body: { error: "boom" } } });
    const { ctx, captured } = makeCtx([]);

    await runEmailLoginCommand(
      ctx,
      { email: "someone@acme.test", cloud: CLOUD },
      { verb: "signup", badge: "signup" },
      pipe("123456"),
    );

    // The labels are a convenience; the credential is the thing. A cloud that
    // cannot answer `whoami` right now has still issued a valid session.
    expect(storedCredential().token).toBe(TOKEN);
    expect(storedCredential().userLabel).toBeUndefined();
    expect(captured.all()).toContain("Welcome to Hogsend");
    expect(captured.all()).not.toContain(TOKEN);
  });
});

describe("hogsend login --email", () => {
  it("takes the emailed-code path and never mints a device code", async () => {
    const { ctx, captured } = makeCtx([]);

    await runEmailLoginCommand(
      ctx,
      { email: "someone@acme.test", cloud: CLOUD },
      { verb: "login", badge: "login" },
      pipe("123456"),
    );

    const paths = calls.map((c) => c.path);
    expect(paths).toContain("/api/cli/signup");
    expect(paths).toContain("/api/cli/signup/verify");
    // The device flow is a DIFFERENT flow, not a fallback: no code is minted
    // and nothing is polled.
    expect(paths).not.toContain("/api/cli/device");
    expect(paths).not.toContain("/api/cli/device/poll");
    expect(storedCredential().token).toBe(TOKEN);
    expect(captured.all()).not.toContain(TOKEN);
  });

  it("never asks a login for an organization name", async () => {
    const { ctx } = makeCtx([]);

    await runEmailLoginCommand(
      ctx,
      { email: "someone@acme.test", cloud: CLOUD },
      { verb: "login", badge: "login" },
      pipe("123456"),
    );

    const verify = calls.find((c) => c.path === "/api/cli/signup/verify");
    expect(verify?.body).not.toHaveProperty("org");
  });

  it("routes argv to the email flow, leaving the device flow the default", async () => {
    // Driven through the REAL command so the routing in `login.ts` is what is
    // under test. A deliberately invalid address stops the flow before the
    // code prompt (which would need a stdin this suite must never touch) —
    // and the refusal it produces is one only the EMAIL path can emit.
    const withEmail = makeCtx(["--email", "not-an-email", "--cloud", CLOUD]);
    await expect(loginCommand.run(withEmail.ctx)).rejects.toBeInstanceOf(
      FailSignal,
    );
    expect(withEmail.captured.all()).toContain("is not an email address");
    expect(calls).toEqual([]);

    // WITHOUT --email the same command is unchanged: it mints a device code.
    // The scripted cloud 404s that path, which is enough to prove which flow
    // ran without standing up the whole device dance again.
    const deviceRun = makeCtx(["--cloud", CLOUD]);
    await loginCommand.run(deviceRun.ctx).catch(() => {});
    expect(calls.map((c) => c.path)).toContain("/api/cli/device");
  });
});
