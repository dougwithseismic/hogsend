import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveArtifactBucketConfig } from "../env";

/**
 * The artifact-bucket configuration contract (PRD 14 task 2): all-or-nothing
 * resolution, the partial-set refusal, the store selection it drives, and the
 * production boot guard — the refusal that makes "production quietly running
 * local disk across two containers" impossible.
 */

const FULL = {
  CLOUD_ARTIFACT_BUCKET_ENDPOINT: "https://bucket.example.test",
  CLOUD_ARTIFACT_BUCKET_NAME: "artifacts",
  CLOUD_ARTIFACT_BUCKET_ACCESS_KEY_ID: "AKIA-test",
  CLOUD_ARTIFACT_BUCKET_SECRET_ACCESS_KEY: "secret-test",
};

describe("resolveArtifactBucketConfig", () => {
  it("resolves undefined when no bucket variable is set", () => {
    expect(resolveArtifactBucketConfig({})).toBeUndefined();
  });

  it("resolves the full config, defaulting the region", () => {
    expect(resolveArtifactBucketConfig(FULL)).toEqual({
      endpoint: FULL.CLOUD_ARTIFACT_BUCKET_ENDPOINT,
      bucket: FULL.CLOUD_ARTIFACT_BUCKET_NAME,
      region: "us-east-1",
      accessKeyId: FULL.CLOUD_ARTIFACT_BUCKET_ACCESS_KEY_ID,
      secretAccessKey: FULL.CLOUD_ARTIFACT_BUCKET_SECRET_ACCESS_KEY,
    });
  });

  it("honours an explicit region", () => {
    expect(
      resolveArtifactBucketConfig({
        ...FULL,
        CLOUD_ARTIFACT_BUCKET_REGION: "eu-west-1",
      })?.region,
    ).toBe("eu-west-1");
  });

  // Every way to be one variable short, each named in its own error — a
  // partial set must never fall back to local disk.
  for (const name of Object.keys(FULL)) {
    it(`throws on a partial set, naming the missing ${name}`, () => {
      const partial = { ...FULL, [name]: undefined };
      expect(() => resolveArtifactBucketConfig(partial)).toThrow(name);
      expect(() => resolveArtifactBucketConfig(partial)).toThrow(/incomplete/);
    });
  }
});

/**
 * The module-level guards in `src/env.ts` and the store selection in
 * `lib/artifacts.ts`, exercised by re-importing the modules under a stubbed
 * `process.env` — the same way a real boot reads it.
 */
describe("env boot guard + store selection", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  /** The variables production's schema withholds defaults for. */
  function stubProductionBaseline(): void {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv(
      "CLOUD_DATABASE_URL",
      "postgres://growthhog:growthhog@localhost:5434/hogsend_cloud",
    );
    vi.stubEnv(
      "CLOUD_ENCRYPTION_SECRET",
      "test-only-production-encryption-secret-0123456789",
    );
    vi.stubEnv(
      "CLOUD_AUTH_SECRET",
      "test-only-production-auth-secret-0123456789abcd",
    );
    vi.stubEnv("CLOUD_SUBSTRATE", "fake");
    vi.stubEnv("CLOUD_BILLING", "disabled");
  }

  function stubBucket(): void {
    for (const [name, value] of Object.entries(FULL)) {
      vi.stubEnv(name, value);
    }
  }

  it("production with no bucket refuses to boot, naming the variables", async () => {
    vi.resetModules();
    stubProductionBaseline();
    await expect(import("../env")).rejects.toThrow(
      /CLOUD_ARTIFACT_BUCKET_ENDPOINT[\s\S]*cannot work in production/,
    );
  });

  it("production with a full bucket boots and selects the S3 store", async () => {
    vi.resetModules();
    stubProductionBaseline();
    stubBucket();
    const { getArtifactStore, setArtifactStore, S3ArtifactStore } =
      await import("../lib/artifacts");
    setArtifactStore(undefined);
    expect(getArtifactStore()).toBeInstanceOf(S3ArtifactStore);
    setArtifactStore(undefined);
  });

  it("a partial bucket set refuses to boot even outside production", async () => {
    vi.resetModules();
    vi.stubEnv("CLOUD_ARTIFACT_BUCKET_ENDPOINT", "https://bucket.example.test");
    await expect(import("../env")).rejects.toThrow(
      /incomplete[\s\S]*CLOUD_ARTIFACT_BUCKET_NAME/,
    );
  });

  it("test env with no bucket boots on the local-disk store", async () => {
    vi.resetModules();
    const { getArtifactStore, setArtifactStore, LocalDiskArtifactStore } =
      await import("../lib/artifacts");
    setArtifactStore(undefined);
    expect(getArtifactStore()).toBeInstanceOf(LocalDiskArtifactStore);
    setArtifactStore(undefined);
  });
});
