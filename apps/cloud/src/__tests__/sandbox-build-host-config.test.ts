import { describe, expect, it } from "vitest";
import { resolveSandboxBuildHostConfig } from "../env";

/**
 * The sandbox build-host resolver (PRD 14 task 3): all-or-nothing, the same
 * posture the artifact bucket set — `local` is a mode, a complete sandbox
 * set is a mode, and everything in between is a boot error that NAMES what
 * is missing. Never a silent fallback.
 */

const COMPLETE = {
  CLOUD_BUILD_HOST: "sandbox" as const,
  CLOUD_RAILWAY_TOKEN: "token",
  CLOUD_BUILD_SANDBOX_ENVIRONMENT_ID: "env-1",
};

describe("resolveSandboxBuildHostConfig", () => {
  it("local host resolves to undefined regardless of the other vars", () => {
    expect(
      resolveSandboxBuildHostConfig(
        { ...COMPLETE, CLOUD_BUILD_HOST: "local" },
        true,
      ),
    ).toBeUndefined();
    expect(
      resolveSandboxBuildHostConfig({ CLOUD_BUILD_HOST: "local" }, false),
    ).toBeUndefined();
  });

  it("a complete set resolves, with defaults applied", () => {
    expect(resolveSandboxBuildHostConfig(COMPLETE, true)).toEqual({
      token: "token",
      environmentId: "env-1",
      idleTimeoutMinutes: 60,
    });
    expect(
      resolveSandboxBuildHostConfig(
        {
          ...COMPLETE,
          CLOUD_BUILD_SANDBOX_REGION: "us-west2",
          CLOUD_BUILD_SANDBOX_IDLE_TIMEOUT_MINUTES: 15,
        },
        true,
      ),
    ).toEqual({
      token: "token",
      environmentId: "env-1",
      region: "us-west2",
      idleTimeoutMinutes: 15,
    });
  });

  it("sandbox without a token throws, naming the variable", () => {
    expect(() =>
      resolveSandboxBuildHostConfig(
        { ...COMPLETE, CLOUD_RAILWAY_TOKEN: undefined },
        true,
      ),
    ).toThrow(/CLOUD_RAILWAY_TOKEN/);
  });

  it("sandbox without an environment throws, naming the variable", () => {
    expect(() =>
      resolveSandboxBuildHostConfig(
        { ...COMPLETE, CLOUD_BUILD_SANDBOX_ENVIRONMENT_ID: undefined },
        true,
      ),
    ).toThrow(/CLOUD_BUILD_SANDBOX_ENVIRONMENT_ID/);
  });

  it("sandbox without a bucket throws — presigned download is S3-only", () => {
    expect(() => resolveSandboxBuildHostConfig(COMPLETE, false)).toThrow(
      /artifact bucket/,
    );
  });

  it("names every missing piece at once, not one per boot", () => {
    expect(() =>
      resolveSandboxBuildHostConfig({ CLOUD_BUILD_HOST: "sandbox" }, false),
    ).toThrow(
      /CLOUD_RAILWAY_TOKEN.*CLOUD_BUILD_SANDBOX_ENVIRONMENT_ID.*artifact bucket/s,
    );
  });
});
