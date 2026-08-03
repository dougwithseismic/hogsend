import { describe, expect, it } from "vitest";
import { DockerImageStore } from "../images/docker";
import { FakeImageStore } from "../images/fake";
import { createFakeExec, type FakeExecCall } from "../images/fake-exec";
import { defaultImageTag, tenantImageTag } from "../images/tags";

/**
 * The image store, both implementations.
 *
 * `DockerImageStore` is tested with an INJECTED exec, so the suite never needs
 * a docker daemon and can assert the exact argv — which is the only place the
 * two laws that matter live: `--platform linux/amd64` (Railway runs amd64, and
 * an arm64 image built on a laptop crash-loops there with an exec-format error)
 * and registry qualification.
 */

function recorder(script?: Parameters<typeof createFakeExec>[0]): {
  exec: ReturnType<typeof createFakeExec>;
  calls: FakeExecCall[];
} {
  const calls: FakeExecCall[] = [];
  return { exec: createFakeExec({ ...script, calls }), calls };
}

describe("image tags", () => {
  it("names the stock scaffold image by engine version", () => {
    expect(defaultImageTag("0.57.0")).toBe("hogsend-default:0.57.0");
  });

  it("names a tenant image by environment and build", () => {
    expect(
      tenantImageTag({
        environmentId: "11111111-2222-3333-4444-555555555555",
        buildId: "66666666-7777-8888-9999-000000000000",
      }),
    ).toBe(
      "hogsend-env-11111111-2222-3333-4444-555555555555:66666666-7777-8888-9999-000000000000",
    );
  });
});

describe("DockerImageStore", () => {
  it("builds for linux/amd64 with the given dockerfile and context", async () => {
    const { exec, calls } = recorder();
    const store = new DockerImageStore({ exec });

    const result = await store.build({
      contextDir: "/work/app",
      dockerfile: "/work/app/Dockerfile",
      tag: "hogsend-default:0.57.0",
    });

    expect(result.reference).toBe("hogsend-default:0.57.0");
    const build = calls.find((call) => call.args[0] === "build");
    expect(build?.command).toBe("docker");
    expect(build?.args).toEqual([
      "build",
      "--platform",
      "linux/amd64",
      "-f",
      "/work/app/Dockerfile",
      "-t",
      "hogsend-default:0.57.0",
      "/work/app",
    ]);
  });

  it("qualifies every reference with the configured registry", async () => {
    const { exec, calls } = recorder();
    const store = new DockerImageStore({
      exec,
      registry: "ghcr.io/withseismic",
    });

    expect(store.reference("hogsend-default:0.57.0")).toBe(
      "ghcr.io/withseismic/hogsend-default:0.57.0",
    );
    await store.build({
      contextDir: "/work/app",
      dockerfile: "/work/app/Dockerfile",
      tag: "hogsend-default:0.57.0",
    });
    const build = calls.find((call) => call.args[0] === "build");
    expect(build?.args).toContain("ghcr.io/withseismic/hogsend-default:0.57.0");
  });

  it("pushes to the registry and reports the digest it printed", async () => {
    const { exec, calls } = recorder({
      pushOutput:
        "The push refers to repository [ghcr.io/withseismic/hogsend-default]\n0.57.0: digest: sha256:abc123 size: 1234\n",
    });
    const store = new DockerImageStore({
      exec,
      registry: "ghcr.io/withseismic",
    });

    const result = await store.push({ tag: "hogsend-default:0.57.0" });

    expect(result.pushed).toBe(true);
    expect(result.reference).toBe("ghcr.io/withseismic/hogsend-default:0.57.0");
    expect(result.digest).toBe("sha256:abc123");
    expect(calls.some((call) => call.args[0] === "push")).toBe(true);
  });

  it("makes push a logged no-op with no registry configured", async () => {
    const notices: string[] = [];
    const { exec, calls } = recorder({
      inspectOutput: "sha256:localimageid\n",
    });
    const store = new DockerImageStore({
      exec,
      onNotice: (message) => notices.push(message),
    });

    const result = await store.push({ tag: "hogsend-default:0.57.0" });

    expect(result.pushed).toBe(false);
    expect(result.reference).toBe("hogsend-default:0.57.0");
    // Local-only still yields an identifier the build row can record.
    expect(result.digest).toBe("sha256:localimageid");
    expect(calls.some((call) => call.args[0] === "push")).toBe(false);
    expect(notices.join(" ")).toMatch(/CLOUD_IMAGE_REGISTRY/);
  });

  it("surfaces a nonzero docker exit as an error carrying the output", async () => {
    const { exec } = recorder({ buildExitCode: 1, output: "no space left" });
    const store = new DockerImageStore({ exec });

    await expect(
      store.build({
        contextDir: "/work/app",
        dockerfile: "/work/app/Dockerfile",
        tag: "hogsend-default:0.57.0",
      }),
    ).rejects.toThrow(/no space left/);
  });
});

describe("FakeImageStore", () => {
  it("is deterministic: the same tag yields the same digest", async () => {
    const store = new FakeImageStore();
    const first = await store.push({ tag: "hogsend-default:0.57.0" });
    const second = await new FakeImageStore().push({
      tag: "hogsend-default:0.57.0",
    });
    expect(first.digest).toBe(second.digest);
    expect(first.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("records calls and honours a scripted failure exactly once", async () => {
    const store = new FakeImageStore();
    store.failNext("build", new Error("scripted"));

    await expect(
      store.build({
        contextDir: "/work",
        dockerfile: "/work/Dockerfile",
        tag: "a:1",
      }),
    ).rejects.toThrow("scripted");
    await expect(
      store.build({
        contextDir: "/work",
        dockerfile: "/work/Dockerfile",
        tag: "a:1",
      }),
    ).resolves.toMatchObject({ reference: "a:1" });
    expect(store.calls.filter((call) => call.method === "build")).toHaveLength(
      2,
    );
  });
});
