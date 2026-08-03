import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The local-disk `ArtifactStore` (PRD 14 task 1), run through the shared
 * contract suite plus the local-only claims a filesystem backing adds: files
 * land at the resolved path under the root, and the active-store resolution is
 * a singleton a test can substitute.
 *
 * The artifacts root is repointed at a temp directory BEFORE `src/env.ts` is
 * loaded, the same law every artifact suite follows, so this file never writes
 * into the repository.
 */
const ARTIFACTS_ROOT = mkdtempSync(join(tmpdir(), "hogsend-artifact-store-"));
process.env.CLOUD_ARTIFACTS_DIR = ARTIFACTS_ROOT;

const { randomUUID } = await import("node:crypto");
const {
  buildArtifactKey,
  getArtifactStore,
  LocalDiskArtifactStore,
  setArtifactStore,
} = await import("../lib/artifacts");
const { describeArtifactStoreContract } = await import(
  "./helpers/artifact-store-contract"
);

describeArtifactStoreContract("LocalDiskArtifactStore", () => {
  return new LocalDiskArtifactStore();
});

describe("LocalDiskArtifactStore — filesystem behaviour", () => {
  it("writes under the configured root at the key's relative path", async () => {
    const store = new LocalDiskArtifactStore();
    const environmentId = randomUUID();
    const buildId = randomUUID();
    const key = buildArtifactKey(environmentId, buildId);
    await store.put(key, new Uint8Array([1, 2]));
    expect(existsSync(join(ARTIFACTS_ROOT, key))).toBe(true);

    await store.removeEnvironment(environmentId);
    expect(existsSync(join(ARTIFACTS_ROOT, environmentId))).toBe(false);
  });
});

describe("getArtifactStore — the active store, resolved once, injectably", () => {
  afterEach(() => {
    setArtifactStore(undefined);
  });

  it("defaults to a local-disk store and returns the same instance", () => {
    const store = getArtifactStore();
    expect(store).toBeInstanceOf(LocalDiskArtifactStore);
    expect(getArtifactStore()).toBe(store);
  });

  it("can be substituted and restored", () => {
    const fake = {
      put: async () => {},
      get: async () => new Uint8Array(),
      remove: async () => {},
      removeEnvironment: async () => {},
    };
    setArtifactStore(fake);
    expect(getArtifactStore()).toBe(fake);
    setArtifactStore(undefined);
    expect(getArtifactStore()).toBeInstanceOf(LocalDiskArtifactStore);
  });
});
