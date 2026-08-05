import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  configurePublish,
  publishCommand,
  resetPublish,
} from "../commands/publish.js";
import type { CommandContext } from "../commands/types.js";
import { whoamiCommand } from "../commands/whoami.js";
import { writeCloudCredential } from "../lib/credentials.js";
import type { Output } from "../lib/output.js";

/**
 * `hogsend publish` healing itself (PRD 16), driven through the REAL command
 * against a scripted cloud, a temp HOME and a temp scaffold.
 *
 * The rule this file exists to hold, above all the others: a NON-INTERACTIVE
 * run never prompts. Not with a default, not with a timeout — never. So every
 * headless case here runs with a POISONED stdin: any code that tried to read
 * it would throw rather than block, which turns "this would have hung in CI"
 * from a timeout somebody has to diagnose into a failing assertion here.
 */

const CLOUD = "http://localhost:3997";
const ENV_ID = "22222222-2222-4222-8222-222222222222";
const BUILD_ID = "33333333-3333-4333-8333-333333333333";

class FailSignal extends Error {
  constructor(readonly failMessage: string) {
    super(failMessage);
    this.name = "FailSignal";
  }
}

let home = "";
let work = "";
let realFetch: typeof globalThis.fetch;
let realStdin: typeof process.stdin;
let calls: string[] = [];

interface Captured {
  lines: string[];
  docs: unknown[];
  all(): string;
}

function makeCtx(
  argv: string[],
  options: { json?: boolean; interactive?: boolean } = {},
): { ctx: CommandContext; captured: Captured } {
  const json = options.json ?? false;
  const interactive = options.interactive ?? false;
  const lines: string[] = [];
  const docs: unknown[] = [];
  let failed = "";

  const out: Output = {
    isJson: json,
    interactive,
    // FAITHFUL to `createOutput`: clack chrome (intro/outro) is a NO-OP when
    // stdout is not a TTY. A stub that recorded them anyway would make a test
    // asserting "the build id was printed" pass for a build id that a piped
    // run never sees — which is the exact bug this suite exists to catch.
    intro(title) {
      if (!json && interactive) lines.push(title);
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
      if (!json && interactive) lines.push(msg);
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

/** One `GET /api/builds/:id` answer. */
function build(over: Record<string, unknown> = {}): unknown {
  return {
    id: BUILD_ID,
    environmentId: ENV_ID,
    status: "queued",
    terminal: false,
    engineVersion: "0.62.0",
    imageDigest: null,
    error: null,
    logTail: null,
    stack: { status: "running" },
    ...over,
  };
}

interface CloudScript {
  /** Answers for the environment list, in order; the last one repeats. */
  environments?: { status: number; body: unknown }[];
  publish?: { status: number; body: unknown };
  /** Build-status answers, in order; the last one repeats. */
  builds?: unknown[];
}

function scriptCloud(script: CloudScript = {}): void {
  const envQueue = [...(script.environments ?? [])];
  const buildQueue = [
    ...(script.builds ?? [build({ status: "succeeded", terminal: true })]),
  ];

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const path = url.slice(CLOUD.length);
    calls.push(path);

    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });

    if (path === "/api/cli/environments") {
      const answer =
        envQueue.length > 1 ? envQueue.shift() : (envQueue[0] ?? null);
      if (answer) return json(answer.status, answer.body);
      return json(200, {
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
      });
    }
    if (path === `/api/publish/${ENV_ID}`) {
      const answer = script.publish ?? {
        status: 202,
        body: { buildId: BUILD_ID, status: "queued" },
      };
      return json(answer.status, answer.body);
    }
    if (path === `/api/builds/${BUILD_ID}`) {
      const answer = buildQueue.length > 1 ? buildQueue.shift() : buildQueue[0];
      return json(200, answer);
    }
    if (path === "/api/cli/session") {
      return json(200, {
        user: { email: "someone@acme.test" },
        organization: { name: "Acme" },
      });
    }
    return json(404, { error: "not_found", message: "no" });
  }) as typeof globalThis.fetch;
}

/** A minimal scaffold: a package.json depending on the engine, and a src tree. */
function makeScaffold(): string {
  const dir = mkdtempSync(join(tmpdir(), "hogsend-publish-app-"));
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

function signIn(): void {
  writeCloudCredential(
    "localhost:3997",
    { token: "hscli_publish_test", createdAt: new Date().toISOString() },
    home,
  );
}

/**
 * An inline-auth seam that EXPLODES if anything tries to ask a question.
 *
 * The poisoned stdin below is the belt; this is the braces, and it is the one
 * that gives a useful failure. Without it, a regression that prompted headlessly
 * shows up as a five-second suite timeout — technically a failure, but one that
 * says nothing about what broke. With it, the assertion names the bug.
 */
const neverPrompt = {
  chooseMethod: async (): Promise<never> => {
    throw new Error("a non-interactive run tried to prompt for an auth method");
  },
  runEmail: async (): Promise<never> => {
    throw new Error("a non-interactive run tried to sign in inline");
  },
  runDevice: async (): Promise<never> => {
    throw new Error("a non-interactive run tried to sign in inline");
  },
};

/**
 * stdin that THROWS if anything reads it.
 *
 * The failure this guards against does not show up as a wrong assertion — it
 * shows up as a suite (or a CI job) that hangs until something kills it. Making
 * the read itself explode turns that into an ordinary test failure.
 */
function poisonStdin(): void {
  Object.defineProperty(process, "stdin", {
    configurable: true,
    get() {
      throw new Error("stdin was read in a non-interactive run");
    },
  });
}

beforeEach(() => {
  realFetch = globalThis.fetch;
  realStdin = process.stdin;
  calls = [];
  home = mkdtempSync(join(tmpdir(), "hogsend-publish-home-"));
  process.env.HOME = home;
  work = makeScaffold();
  scriptCloud();
  // No wall-clock waiting anywhere in this file: the poll loop is the thing
  // under test, not the three seconds between polls.
  resetPublish();
  configurePublish({ pollIntervalMs: 1, sleep: async () => {} });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  Object.defineProperty(process, "stdin", {
    configurable: true,
    value: realStdin,
  });
  resetPublish();
});

const args = (extra: string[] = []) => [
  "--cloud",
  CLOUD,
  "--cwd",
  work,
  ...extra,
];

describe("hogsend publish — no session", () => {
  it("refuses headlessly with the exact commands, and reads no stdin", async () => {
    poisonStdin();
    configurePublish({
      pollIntervalMs: 1,
      sleep: async () => {},
      auth: neverPrompt,
    });
    const { ctx, captured } = makeCtx(args());

    await expect(publishCommand.run(ctx)).rejects.toBeInstanceOf(FailSignal);

    const text = captured.all();
    expect(text).toContain("Not signed in");
    // BOTH doors, with the --cloud the caller actually used, so the printed
    // command can be pasted rather than adapted.
    expect(text).toContain(
      `hogsend login --email you@example.com --cloud ${CLOUD}`,
    );
    expect(text).toContain("hogsend signup --email");
    // Refused before touching the cloud, and before packing anything.
    expect(calls).toEqual([]);
  });

  it("refuses under --json even with a terminal — a prompt would corrupt the document", async () => {
    poisonStdin();
    configurePublish({
      pollIntervalMs: 1,
      sleep: async () => {},
      auth: neverPrompt,
    });
    const { ctx, captured } = makeCtx(args(), {
      json: true,
      interactive: true,
    });

    await expect(publishCommand.run(ctx)).rejects.toBeInstanceOf(FailSignal);
    expect(captured.all()).toContain("hogsend login --email");
    expect(calls).toEqual([]);
  });

  it("signs in INLINE on a terminal and finishes the same publish", async () => {
    let chose = 0;
    configurePublish({
      pollIntervalMs: 1,
      sleep: async () => {},
      auth: {
        chooseMethod: async () => {
          chose += 1;
          return "email";
        },
        // The real flow is exercised in its own suite; here it only has to do
        // what signing in does — leave a credential behind.
        runEmail: async () => signIn(),
      },
    });

    const { ctx, captured } = makeCtx(args(), { interactive: true });
    await publishCommand.run(ctx);

    expect(chose).toBe(1);
    // ONE invocation: the publish continued rather than telling the human to
    // run it again.
    expect(calls).toContain("/api/cli/environments");
    expect(calls).toContain(`/api/publish/${ENV_ID}`);
    expect(captured.all()).toContain("Deployed to production");
  });

  it("honours the browser choice, and runs neither flow twice", async () => {
    let device = 0;
    let email = 0;
    configurePublish({
      pollIntervalMs: 1,
      sleep: async () => {},
      auth: {
        chooseMethod: async () => "browser",
        runEmail: async () => {
          email += 1;
          signIn();
        },
        runDevice: async () => {
          device += 1;
          signIn();
        },
      },
    });

    const { ctx } = makeCtx(args(), { interactive: true });
    await publishCommand.run(ctx);

    expect(device).toBe(1);
    expect(email).toBe(0);
  });
});

describe("hogsend publish — revoked session", () => {
  it("refuses headlessly, naming the remedy rather than a bare 401", async () => {
    poisonStdin();
    configurePublish({
      pollIntervalMs: 1,
      sleep: async () => {},
      auth: neverPrompt,
    });
    signIn();
    scriptCloud({
      environments: [
        {
          status: 401,
          body: {
            error: "invalid_token",
            message: "That credential is not valid.",
          },
        },
      ],
    });
    const { ctx, captured } = makeCtx(args());

    await expect(publishCommand.run(ctx)).rejects.toBeInstanceOf(FailSignal);

    const text = captured.all();
    expect(text).toContain("no longer valid");
    expect(text).toContain("hogsend login --email");
    // It stopped at the first call; nothing was packed or uploaded.
    expect(calls).toEqual(["/api/cli/environments"]);
  });

  it("re-authenticates inline on a terminal and retries ONCE", async () => {
    signIn();
    scriptCloud({
      environments: [
        {
          status: 401,
          body: {
            error: "invalid_token",
            message: "That credential is not valid.",
          },
        },
        {
          status: 200,
          body: {
            organization: { id: "org-1", name: "Acme" },
            environments: [
              {
                id: ENV_ID,
                name: "production",
                kind: "production",
                stackStatus: "running",
                engineVersion: null,
              },
            ],
          },
        },
      ],
    });

    let signedIn = 0;
    configurePublish({
      pollIntervalMs: 1,
      sleep: async () => {},
      auth: {
        chooseMethod: async () => "email",
        runEmail: async () => {
          signedIn += 1;
          signIn();
        },
      },
    });

    const { ctx, captured } = makeCtx(args(), { interactive: true });
    await publishCommand.run(ctx);

    expect(signedIn).toBe(1);
    // Exactly two listings: the one that was refused, and the retry. A loop
    // here would hide a second 401 that means something else entirely.
    expect(calls.filter((p) => p === "/api/cli/environments")).toHaveLength(2);
    expect(captured.all()).toContain("signing you in again");
    expect(captured.all()).toContain("Deployed to production");
  });
});

describe("hogsend publish — provisioning phases", () => {
  it("narrates the instance, hands off to the build, and prints each phase once", async () => {
    signIn();
    scriptCloud({
      builds: [
        build({ status: "building", stack: { status: "requested" } }),
        build({ status: "building", stack: { status: "provisioning" } }),
        build({ status: "building", stack: { status: "provisioning" } }),
        build({ status: "building", stack: { status: "running" } }),
        build({ status: "pushing", stack: { status: "running" } }),
        build({
          status: "succeeded",
          terminal: true,
          stack: { status: "running" },
          logTail: "",
        }),
      ],
    });

    const { ctx, captured } = makeCtx(args(), { interactive: true });
    await publishCommand.run(ctx);

    const text = captured.all();
    // Provisioning phases read as sentences about the INSTANCE, so they cannot
    // be mistaken for the build's own bare status words.
    expect(text).toContain("provisioning your instance");
    expect(text).toContain("instance ready — deploying your app");
    // ...and each exactly once, despite two identical `provisioning` polls.
    const provisioning = captured.lines.filter((l) =>
      l.includes("creating database"),
    );
    expect(provisioning).toHaveLength(1);
    const handoff = captured.lines.filter((l) => l.includes("instance ready"));
    expect(handoff).toHaveLength(1);
    // The build narrative continues after the handoff rather than restarting.
    expect(text).toContain("pushing");
    // And it does not INTERLEAVE: while the instance is being created the
    // build says `building` only because it is waiting for substrate, so that
    // line belongs after the handoff, not between two provisioning lines.
    const order = captured.lines.filter(
      (l) => l.includes("instance ready") || l.trim() === "building",
    );
    expect(order[0]).toContain("instance ready");
    expect(text).toContain("Deployed to production");
  });

  it("says nothing about provisioning when there was none", async () => {
    signIn();
    scriptCloud({
      builds: [
        build({ status: "building" }),
        build({ status: "succeeded", terminal: true, logTail: "" }),
      ],
    });

    const { ctx, captured } = makeCtx(args(), { interactive: true });
    await publishCommand.run(ctx);

    const text = captured.all();
    // An ordinary publish onto a running stack must not gain a line about
    // instances being created — it would be a lie, and a confusing one.
    expect(text).not.toContain("provisioning your instance");
    expect(text).not.toContain("instance ready");
  });

  it("exits nonzero when provisioning fails terminally", async () => {
    signIn();
    scriptCloud({
      builds: [
        build({ status: "building", stack: { status: "provisioning" } }),
        build({ status: "building", stack: { status: "error" } }),
      ],
    });

    const { ctx, captured } = makeCtx(args(), { interactive: true });
    await expect(publishCommand.run(ctx)).rejects.toBeInstanceOf(FailSignal);

    const text = captured.all();
    expect(text).toContain("Provisioning failed");
    // The next move, not just the fact.
    expect(text).toContain("publish again once it reports running");
  });

  it("tolerates a cloud that does not send the stack field at all", async () => {
    signIn();
    scriptCloud({
      builds: [
        // An older control plane: no `stack` key anywhere in the payload.
        {
          id: BUILD_ID,
          environmentId: ENV_ID,
          status: "building",
          terminal: false,
          engineVersion: "0.62.0",
          imageDigest: null,
          error: null,
          logTail: null,
        },
        {
          id: BUILD_ID,
          environmentId: ENV_ID,
          status: "succeeded",
          terminal: true,
          engineVersion: "0.62.0",
          imageDigest: "sha256:abc",
          error: null,
          logTail: "",
        },
      ],
    });

    const { ctx, captured } = makeCtx(args(), { interactive: true });
    await publishCommand.run(ctx);
    expect(captured.all()).toContain("Deployed to production");
  });
});

describe("hogsend publish --no-wait", () => {
  it("prints the build id and exits 0 when stdout is NOT a tty", async () => {
    poisonStdin();
    signIn();
    const { ctx, captured } = makeCtx(args(["--no-wait"]));

    await publishCommand.run(ctx);

    // The id is the entire output of a --no-wait publish, and it used to be
    // printed through clack's outro — a no-op off a TTY, so a piped run got
    // NOTHING to script against (PRD 07 known-minor).
    expect(captured.lines.join("\n")).toContain(BUILD_ID);
    // It really did stop after the intake: no build was polled.
    expect(calls).not.toContain(`/api/builds/${BUILD_ID}`);
  });

  it("emits the id in --json too, and still never polls", async () => {
    poisonStdin();
    signIn();
    const { ctx, captured } = makeCtx(args(["--no-wait"]), { json: true });

    await publishCommand.run(ctx);

    expect(captured.docs).toHaveLength(1);
    expect(captured.docs[0]).toMatchObject({
      published: true,
      buildId: BUILD_ID,
      waited: false,
    });
    expect(calls).not.toContain(`/api/builds/${BUILD_ID}`);
  });
});

describe("hogsend whoami — revoked session", () => {
  it("says plainly that the session is dead and names the way back", async () => {
    poisonStdin();
    signIn();
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: "invalid_token",
          message: "That credential is not valid.",
        }),
        { status: 401, headers: { "content-type": "application/json" } },
      )) as typeof globalThis.fetch;

    const { ctx, captured } = makeCtx(["--cloud", CLOUD]);
    await expect(whoamiCommand.run(ctx)).rejects.toBeInstanceOf(FailSignal);

    const text = captured.all();
    // The QUESTION whoami is being asked is "am I signed in", so a revoked
    // session must answer it in words rather than with a bare 401.
    expect(text).toContain("revoked");
    expect(text).toContain("hogsend login");
    expect(text).toContain("hogsend login --email");
  });

  it("names both doors when there is no session at all", async () => {
    poisonStdin();
    const { ctx, captured } = makeCtx(["--cloud", CLOUD]);

    await expect(whoamiCommand.run(ctx)).rejects.toBeInstanceOf(FailSignal);
    expect(captured.all()).toContain("Not signed in");
    expect(captured.all()).toContain("--email you@example.com");
  });
});
