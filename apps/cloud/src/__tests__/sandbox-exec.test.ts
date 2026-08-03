import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { EXEC_NOT_STARTED } from "../images/exec";
import {
  buildBootstrapScript,
  buildLoginCommand,
  createSandboxBuildSession,
  type SandboxApi,
  type SandboxBuildSessionOptions,
  type SandboxExecOutcome,
} from "../images/sandbox-exec";
import { quoteShellArg, renderArgv } from "../images/shell-quote";

/**
 * The sandbox build host (PRD 14 task 3). Two stakes in the ground:
 *
 *  - the argv→string join is proven against a REAL bash, not by eyeballing
 *    quoted output — every hostile shape (spaces, quotes, `$()`, backticks,
 *    semicolons, newlines) must arrive as a literal argument, because some
 *    of those values derive from tenant input;
 *  - the sandbox is ALWAYS destroyed, including when the build fails or
 *    throws, because a leaked sandbox is a running VM nobody is watching.
 */

/** Argument shapes an attacker (or a filename) would use to break out. */
const HOSTILE_ARGS = [
  "plain",
  "with spaces here",
  "single'quote",
  "it's; two 'quotes'",
  "$(touch /tmp/pwned)",
  "`touch /tmp/pwned`",
  "a; rm -rf /",
  "line1\nline2",
  "semi;colon && echo no | cat > x",
  "$HOME and ${PATH}",
  "star * and ? glob",
  'double "quotes" too',
  "back\\slash",
  "!history",
];

/** Run one rendered command through a real bash and return its stdout. */
function bashRun(command: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", command], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, out }));
  });
}

describe("shell quoting", () => {
  it("every hostile argument arrives verbatim through a real bash", async () => {
    // node prints its argv as JSON; if any argument were interpreted by the
    // shell (split, expanded, executed) the round trip would not match.
    const command = renderArgv(process.execPath, [
      "-e",
      "console.log(JSON.stringify(process.argv.slice(1)))",
      "--",
      ...HOSTILE_ARGS,
    ]);
    const result = await bashRun(command);
    expect(result.code).toBe(0);
    // node consumes the `--` separator itself; the payload survives intact.
    expect(JSON.parse(result.out)).toEqual(HOSTILE_ARGS);
  });

  it("wraps in single quotes and escapes embedded quotes", () => {
    expect(quoteShellArg("abc")).toBe("'abc'");
    expect(quoteShellArg("a'b")).toBe("'a'\\''b'");
    expect(quoteShellArg("$(x)")).toBe("'$(x)'");
  });

  it("refuses a NUL byte rather than truncating", () => {
    expect(() => quoteShellArg("a\0b")).toThrow(/NUL/);
  });
});

// ---------------------------------------------------------------------------

interface RecordedExec {
  command: string;
  timeoutSec: number;
}

/** A scripted SandboxApi that records everything. */
function fakeApi(
  answer: (command: string) => Partial<SandboxExecOutcome> = () => ({}),
) {
  const execs: RecordedExec[] = [];
  const destroyed: string[] = [];
  let created = 0;
  const api: SandboxApi = {
    async create() {
      created += 1;
      return { id: `sbx-${created}` };
    },
    async exec({ command, timeoutSec }) {
      execs.push({ command, timeoutSec });
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
        truncated: false,
        ...answer(command),
      };
    },
    async destroy({ id }) {
      destroyed.push(id);
    },
  };
  return {
    api,
    execs,
    destroyed,
    get created() {
      return created;
    },
  };
}

const SECRET = "p@ss'wo$(rd)`x`";

function sessionOptions(
  api: SandboxApi,
  extra: Partial<SandboxBuildSessionOptions> = {},
): SandboxBuildSessionOptions {
  return {
    api,
    environmentId: "env-1",
    workDir: "/artifacts/.work/build-1",
    artifactUrl: "https://bucket.example/signed?sig=SIGNATURE",
    templateDockerfile: "FROM node:22\n",
    templatePreflight: "#!/usr/bin/env bash\necho gate\n",
    ...extra,
  };
}

describe("createSandboxBuildSession", () => {
  it("creates lazily, bootstraps once, and runs commands remotely", async () => {
    const fake = fakeApi(() => ({ stdout: "ok\n" }));
    const session = createSandboxBuildSession(sessionOptions(fake.api));
    expect(fake.created).toBe(0);

    const result = await session.exec("docker", ["build", "-t", "x", "."]);
    expect(fake.created).toBe(1);
    // Bootstrap + the user command.
    expect(fake.execs).toHaveLength(2);
    expect(fake.execs[0]?.command).toContain("tar -xzf");
    expect(fake.execs[1]?.command).toBe("'docker' 'build' '-t' 'x' '.'");
    expect(result).toEqual({ code: 0, output: "ok\n", timedOut: false });

    // Second command: no second sandbox, no second bootstrap.
    await session.exec("docker", ["push", "x"]);
    expect(fake.created).toBe(1);
    expect(fake.execs).toHaveLength(3);
  });

  it("prefixes cwd and forwards only non-host env", async () => {
    const fake = fakeApi();
    const session = createSandboxBuildSession(sessionOptions(fake.api));
    await session.exec("bash", ["gate.sh"], {
      cwd: "/artifacts/.work/build-1/app",
      env: {
        NODE_ENV: "production",
        PATH: "/worker/only/bin",
        DOCKER_HOST: "unix:///worker.sock",
      },
    });
    const command = fake.execs.at(-1)?.command ?? "";
    expect(command).toBe(
      "cd '/artifacts/.work/build-1/app' && " +
        "env 'NODE_ENV=production' 'bash' 'gate.sh'",
    );
    // The worker's machine facts never leak into the sandbox.
    expect(command).not.toContain("/worker/only/bin");
    expect(command).not.toContain("worker.sock");
  });

  it("maps timeoutMs to whole seconds and passes timedOut through", async () => {
    // Only the USER command times out — the bootstrap must succeed first.
    const fake = fakeApi((command) =>
      command.startsWith("'docker'") ? { exitCode: 137, timedOut: true } : {},
    );
    const session = createSandboxBuildSession(sessionOptions(fake.api));
    const result = await session.exec("docker", ["build"], {
      timeoutMs: 1500,
    });
    expect(fake.execs.at(-1)?.timeoutSec).toBe(2);
    expect(result.timedOut).toBe(true);
    expect(result.code).toBe(137);
  });

  it("merges stdout+stderr, marks truncation, and streams to onOutput", async () => {
    const fake = fakeApi((command) =>
      command.startsWith("'docker'")
        ? { stdout: "out", stderr: "err", truncated: true }
        : {},
    );
    const session = createSandboxBuildSession(sessionOptions(fake.api));
    const chunks: string[] = [];
    const result = await session.exec("docker", ["build"], {
      onOutput: (chunk) => chunks.push(chunk),
    });
    expect(result.output).toContain("out");
    expect(result.output).toContain("err");
    expect(result.output).toContain("truncated");
    expect(chunks.join("")).toBe(result.output);
  });

  it("bootstrap replicates the pipeline's file rules", () => {
    const script = buildBootstrapScript({
      workDir: "/artifacts/.work/b1",
      artifactUrl: "https://x/y?sig=s",
      templateDockerfile: "FROM node\n",
      templatePreflight: "echo gate\n",
    });
    // Dockerfile only when the archive shipped none…
    expect(script).toMatch(/if \[ ! -f "\$APP\/Dockerfile" \]/);
    // …preflight ALWAYS overwritten (no guard around its write).
    expect(script).toContain('> "$APP/scripts/preflight.sh"');
    // curl's stderr (which echoes the presigned URL) is discarded.
    expect(script).toContain("2>/dev/null");
    // File contents travel as shell-inert base64, not as raw text.
    expect(script).not.toContain("FROM node");
  });

  it("a failed bootstrap surfaces as exit 127 without the presigned URL", async () => {
    const fake = fakeApi((command) =>
      command.includes("tar -xzf")
        ? { exitCode: 70, stdout: "artifact download failed\n" }
        : {},
    );
    const session = createSandboxBuildSession(sessionOptions(fake.api));
    const result = await session.exec("docker", ["build"]);
    expect(result.code).toBe(EXEC_NOT_STARTED);
    expect(result.output).toContain("bootstrap failed");
    expect(result.output).not.toContain("SIGNATURE");
    // The half-bootstrapped sandbox is still destroyed.
    await session.dispose();
    expect(fake.destroyed).toEqual(["sbx-1"]);
  });

  it("an api failure mid-build is a result, not a rejection — and dispose still destroys", async () => {
    let calls = 0;
    const fake = fakeApi();
    const failing: SandboxApi = {
      ...fake.api,
      async exec(input) {
        calls += 1;
        if (calls > 1) throw new Error("Railway API error (HTTP 500)");
        return fake.api.exec(input);
      },
    };
    const session = createSandboxBuildSession(sessionOptions(failing));
    const result = await session.exec("docker", ["build"]);
    expect(result.code).toBe(EXEC_NOT_STARTED);
    expect(result.output).toContain("sandbox exec failed");
    await session.dispose();
    expect(fake.destroyed).toEqual(["sbx-1"]);
  });

  it("dispose without any exec destroys nothing", async () => {
    const fake = fakeApi();
    const session = createSandboxBuildSession(sessionOptions(fake.api));
    await session.dispose();
    expect(fake.created).toBe(0);
    expect(fake.destroyed).toEqual([]);
  });

  it("dispose is idempotent and swallows a failed destroy", async () => {
    const fake = fakeApi();
    let destroys = 0;
    const flaky: SandboxApi = {
      ...fake.api,
      async destroy() {
        destroys += 1;
        throw new Error("beta API hiccup");
      },
    };
    const session = createSandboxBuildSession(sessionOptions(flaky));
    await session.exec("docker", ["build"]);
    await expect(session.dispose()).resolves.toBeUndefined();
    await session.dispose();
    expect(destroys).toBe(1);
  });
});

describe("docker login containment", () => {
  it("logs in via stdin with the password fully quoted", () => {
    const command = buildLoginCommand({
      server: "ghcr.io",
      username: "bot",
      password: SECRET,
    });
    expect(command).toContain("--password-stdin");
    // Never an argument to docker itself.
    expect(command).not.toMatch(/-p\s/);
    // Quoted through the tested quoter, so metacharacters stay inert.
    expect(command).toContain(quoteShellArg(SECRET));
  });

  it("the password reaches docker literally even with shell metacharacters", async () => {
    // Substitute `cat` for docker: whatever lands on stdin is what docker
    // login would have received.
    const command = buildLoginCommand({
      server: "ghcr.io",
      username: "bot",
      password: SECRET,
    }).replace(/\| docker login .*$/, "| cat");
    const result = await bashRun(command);
    expect(result.code).toBe(0);
    expect(result.out).toBe(SECRET);
  });

  it("the secret never reaches build output, onOutput, or error messages", async () => {
    const fake = fakeApi((command) =>
      command.includes("docker login")
        ? { exitCode: 1, stderr: `denied for ${SECRET}` }
        : {},
    );
    const session = createSandboxBuildSession(
      sessionOptions(fake.api, {
        registryLogin: {
          server: "ghcr.io",
          username: "bot",
          password: SECRET,
        },
      }),
    );
    const chunks: string[] = [];
    const result = await session.exec("docker", ["push", "x"], {
      onOutput: (chunk) => chunks.push(chunk),
    });
    // Login failed → the build cannot start, but nothing that surfaced —
    // the result, the streamed chunks — carries the credential, even though
    // the fake maliciously echoed it back.
    expect(result.code).toBe(EXEC_NOT_STARTED);
    expect(result.output).not.toContain(SECRET);
    expect(chunks.join("")).not.toContain(SECRET);
    expect(result.output).toContain("docker login to ghcr.io failed");
  });

  it("a successful login's output is dropped, not streamed", async () => {
    const fake = fakeApi((command) =>
      command.includes("docker login")
        ? { stdout: "Login Succeeded (config warning mentioning creds)" }
        : { stdout: "pushed\n" },
    );
    const session = createSandboxBuildSession(
      sessionOptions(fake.api, {
        registryLogin: { server: "ghcr.io", username: "bot", password: "x" },
      }),
    );
    const chunks: string[] = [];
    const result = await session.exec("docker", ["push", "x"], {
      onOutput: (chunk) => chunks.push(chunk),
    });
    expect(result.code).toBe(0);
    expect(chunks.join("")).not.toContain("Login Succeeded");
    // Login ran, between bootstrap and the push.
    expect(fake.execs.map((entry) => entry.command.split(" ")[0])).toEqual([
      "set",
      "printf",
      "'docker'",
    ]);
  });
});
