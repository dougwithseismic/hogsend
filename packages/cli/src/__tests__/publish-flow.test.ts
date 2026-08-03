import { describe, expect, it } from "vitest";
import {
  CloudError,
  createCloudClient,
  type FetchLike,
} from "../lib/cloud-http.js";
import { describeCloudRefusal, formatRefusal } from "../lib/cloud-refusals.js";
import {
  assertBuildSucceeded,
  type BuildStatusResponse,
  type CloudEnvironment,
  PublishError,
  type PublishFlowDeps,
  selectEnvironment,
  uploadPublish,
  watchBuild,
} from "../lib/publish-flow.js";

/**
 * `hogsend publish`'s conversation with the control plane, against a scripted
 * server: which environment a publish means, what each refusal reads like at a
 * terminal, and the status loop's exit conditions.
 *
 * The refusal cases are the point. A CLI that echoes the server's message and
 * leaves the operator guessing which flag unblocks them is a CLI that fails
 * exactly when somebody is under pressure, so every branch is asserted to name
 * a NEXT MOVE — the flag, the command, or the person.
 */

const BASE_URL = "https://cloud.hogsend.test";
const CTX = { cloudHost: "cloud.hogsend.test", envName: "production" };

function environment(over: Partial<CloudEnvironment> = {}): CloudEnvironment {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "production",
    kind: "production",
    stackStatus: "running",
    engineVersion: "0.57.0",
    ...over,
  };
}

interface Scripted {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

function harness(script: Record<string, Scripted[]>) {
  const calls: string[] = [];
  const lines: string[] = [];
  const remaining: Record<string, Scripted[]> = {};
  for (const [path, answers] of Object.entries(script)) {
    remaining[path] = [...answers];
  }
  let clock = 0;

  const fetchImpl: FetchLike = async (url) => {
    const path = new URL(url).pathname;
    calls.push(path);
    const queue = remaining[path];
    if (!queue || queue.length === 0) throw new Error(`unscripted: ${path}`);
    const answer = (queue.length > 1 ? queue.shift() : queue[0]) as Scripted;
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { "content-type": "application/json", ...answer.headers },
    });
  };

  const deps: PublishFlowDeps = {
    client: createCloudClient({
      baseUrl: BASE_URL,
      token: "hscli_secret",
      fetchImpl,
    }),
    emit: (line) => lines.push(line),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  };

  return { deps, lines, calls };
}

function upload(deps: PublishFlowDeps) {
  return uploadPublish(
    {
      environmentId: environment().id,
      archive: new Uint8Array([0x1f, 0x8b, 0, 0]),
      manifest: { engineVersion: "0.57.0" },
    },
    deps,
    CTX,
  );
}

describe("selectEnvironment", () => {
  it("defaults to production by KIND, then by name", () => {
    const staging = environment({ id: "s", name: "staging", kind: "staging" });
    expect(selectEnvironment([staging, environment()]).name).toBe("production");

    // An org whose kinds predate the single-production rule still resolves.
    expect(
      selectEnvironment([
        staging,
        environment({ id: "p", name: "production", kind: "test" }),
      ]).id,
    ).toBe("p");
  });

  it("matches --env EXACTLY, and names what exists on a miss", () => {
    const rows = [
      environment(),
      environment({ id: "s", name: "staging", kind: "staging" }),
    ];
    expect(selectEnvironment(rows, "staging").id).toBe("s");

    // A near-match is not a match: guessing would deploy to the wrong place.
    const error = (() => {
      try {
        selectEnvironment(rows, "stagng");
      } catch (thrown) {
        return thrown;
      }
    })();
    expect(error).toBeInstanceOf(PublishError);
    expect((error as PublishError).verdict).toBe("no_environment");
    expect((error as PublishError).hint).toContain("staging");
  });

  it("refuses an org with nothing to publish to", () => {
    expect(() => selectEnvironment([])).toThrow(PublishError);
  });
});

describe("refusal rendering", () => {
  const render = (status: number, body: unknown, headers?: Headers) =>
    formatRefusal(
      describeCloudRefusal(
        new CloudError({
          message: (body as { message?: string } | null)?.message ?? "failed",
          status,
          ...((body as { error?: string } | null)?.error
            ? { code: (body as { error: string }).error }
            : {}),
          body,
          ...(headers?.get("retry-after")
            ? { retryAfter: Number(headers.get("retry-after")) }
            : {}),
        }),
        CTX,
      ),
    );

  it("401 → run hogsend login", () => {
    const text = render(401, { error: "invalid_token", message: "nope" });
    expect(text).toContain("cloud.hogsend.test");
    expect(text).toContain("hogsend login");
  });

  it("403 forbidden_role → ask an admin; forbidden_organization → log in again", () => {
    expect(
      render(403, {
        error: "forbidden_role",
        message:
          "Publishing needs one of these roles: owner, admin, developer.",
      }),
    ).toContain("owner or admin");

    expect(
      render(403, {
        error: "forbidden_organization",
        message: "That CLI session belongs to a different organization.",
      }),
    ).toContain("hogsend login");
  });

  it("409 engine_version_mismatch → BOTH versions and the exact flag", () => {
    const text = render(409, {
      error: "engine_version_mismatch",
      message: "mismatch",
      stackVersion: "0.56.0",
      manifestVersion: "0.57.3",
    });
    expect(text).toContain("0.56.0");
    expect(text).toContain("0.57.3");
    expect(text).toContain("--allow-upgrade");
    // And it names WHICH environment, so a multi-env operator is not guessing.
    expect(text).toContain("production");
  });

  it("413 → point at .gitignore, naming what is already excluded", () => {
    const text = render(413, {
      error: "payload_too_large",
      message: "The tarball is larger than the 64MB limit.",
    });
    expect(text).toContain("64MB");
    expect(text).toContain(".gitignore");
    expect(text).toContain("node_modules");
  });

  it("429 build_queue_full → the retry-after, and why the queue is bounded", () => {
    const text = render(
      429,
      { error: "build_queue_full", message: "Too many queued builds." },
      new Headers({ "retry-after": "60" }),
    );
    expect(text).toContain("60s");
    expect(text).toContain("build host");
  });

  it("a transport failure is reported as unreachable, not as a refusal", () => {
    const text = formatRefusal(
      describeCloudRefusal(
        new CloudError({
          message: "cannot reach cloud (ECONNREFUSED)",
          status: 0,
        }),
        CTX,
      ),
    );
    expect(text).toContain("cannot reach");
    expect(text).toContain("network");
  });
});

describe("uploadPublish", () => {
  it("returns the queued build id on 202", async () => {
    const { deps, calls } = harness({
      [`/api/publish/${environment().id}`]: [
        { status: 202, body: { buildId: "build-1", status: "queued" } },
      ],
    });

    await expect(upload(deps)).resolves.toEqual({
      buildId: "build-1",
      status: "queued",
    });
    expect(calls).toEqual([`/api/publish/${environment().id}`]);
  });

  it("turns every intake refusal into a PublishError carrying the next move", async () => {
    const { deps } = harness({
      [`/api/publish/${environment().id}`]: [
        {
          status: 409,
          body: {
            error: "engine_version_mismatch",
            message: "mismatch",
            stackVersion: "0.56.0",
            manifestVersion: "0.57.3",
          },
        },
      ],
    });

    const error = await upload(deps).catch((thrown) => thrown);
    expect(error).toBeInstanceOf(PublishError);
    expect((error as PublishError).verdict).toBe("refused");
    expect((error as PublishError).message).toContain("0.56.0");
    expect((error as PublishError).hint).toContain("--allow-upgrade");
  });
});

describe("watchBuild", () => {
  const build = (over: Partial<BuildStatusResponse>): Scripted => ({
    status: 200,
    body: {
      id: "build-1",
      environmentId: environment().id,
      status: "queued",
      terminal: false,
      engineVersion: "0.57.0",
      imageDigest: null,
      error: null,
      logTail: null,
      ...over,
    },
  });

  it("prints each TRANSITION once and returns at the terminal state", async () => {
    const { deps, lines } = harness({
      "/api/builds/build-1": [
        build({ status: "queued" }),
        build({ status: "queued" }),
        build({ status: "building" }),
        build({ status: "deploying" }),
        build({
          status: "succeeded",
          terminal: true,
          imageDigest: "sha256:abc",
          logTail: "",
        }),
      ],
    });

    const result = await watchBuild(
      { buildId: "build-1", intervalMs: 1 },
      deps,
      CTX,
    );
    expect(result.status).toBe("succeeded");
    // A line every three seconds would bury the one that matters, so a repeat
    // of the same status prints nothing.
    expect(lines).toEqual([
      "  queued",
      "  building",
      "  deploying",
      "  succeeded",
    ]);
  });

  it("gives up at the timeout rather than polling a stuck build forever", async () => {
    const { deps } = harness({
      "/api/builds/build-1": [build({ status: "building" })],
    });

    await expect(
      watchBuild(
        { buildId: "build-1", intervalMs: 1_000, timeoutMs: 5_000 },
        deps,
        CTX,
      ),
    ).rejects.toMatchObject({ verdict: "timeout" });
  });

  it("surfaces a 404 as a refusal with the credential hint", async () => {
    const { deps } = harness({
      "/api/builds/build-1": [
        {
          status: 404,
          body: { error: "build_not_found", message: "No such build." },
        },
      ],
    });

    const error = await watchBuild(
      { buildId: "build-1", intervalMs: 1 },
      deps,
      CTX,
    ).catch((thrown) => thrown);
    expect(error).toBeInstanceOf(PublishError);
    expect((error as PublishError).verdict).toBe("refused");
  });
});

describe("assertBuildSucceeded", () => {
  const terminal = (
    over: Partial<BuildStatusResponse>,
  ): BuildStatusResponse => ({
    id: "build-1",
    environmentId: environment().id,
    status: "failed",
    terminal: true,
    engineVersion: "0.57.0",
    imageDigest: null,
    error: "pnpm build exited 1",
    logTail: "ERR_PNPM_… tail of the log",
    ...over,
  });

  it("passes a success", () => {
    expect(() =>
      assertBuildSucceeded(terminal({ status: "succeeded", error: null })),
    ).not.toThrow();
  });

  it("throws on a failure, carrying the reason AND the tail", () => {
    const error = (() => {
      try {
        assertBuildSucceeded(terminal({}));
      } catch (thrown) {
        return thrown as PublishError;
      }
    })() as PublishError;

    // This is what makes `hogsend publish` exit nonzero on a failed build.
    expect(error.verdict).toBe("build_failed");
    expect(error.message).toContain("pnpm build exited 1");
    expect(error.logTail).toContain("tail of the log");
  });
});
