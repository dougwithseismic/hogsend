import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ArtifactStore } from "../../lib/artifacts";
import { buildArtifactKey } from "../../lib/artifacts";

/**
 * The `ArtifactStore` CONTRACT, as one reusable suite.
 *
 * Every implementation — local disk today, S3 next (PRD 14 task 2) — is run
 * through this same block, so the two cannot drift apart on the behaviours the
 * pipeline leans on: a round-trip returns the exact bytes, a delete tolerates
 * absence (both cleanup callers are best-effort compensations), an environment
 * removal takes every key under that environment and nothing else, and a key
 * that is not `<uuid>/<uuid>.tar.gz` is refused BEFORE any I/O — on the S3
 * path a bad key is an object name rather than a filesystem path, but the
 * validation posture is identical.
 */
export function describeArtifactStoreContract(
  name: string,
  makeStore: () => ArtifactStore | Promise<ArtifactStore>,
): void {
  describe(`ArtifactStore contract — ${name}`, () => {
    const freshKey = () => {
      const environmentId = randomUUID();
      const buildId = randomUUID();
      return {
        environmentId,
        buildId,
        key: buildArtifactKey(environmentId, buildId),
      };
    };

    it("round-trips put → get with the exact bytes", async () => {
      const store = await makeStore();
      const { key } = freshKey();
      const bytes = new Uint8Array([0x1f, 0x8b, 0x01, 0x02, 0x03, 0xff]);
      await store.put(key, bytes);
      const read = await store.get(key);
      expect(Array.from(read)).toEqual(Array.from(bytes));
    });

    it("overwrites on a second put to the same key", async () => {
      const store = await makeStore();
      const { key } = freshKey();
      await store.put(key, new Uint8Array([1, 2, 3]));
      await store.put(key, new Uint8Array([9]));
      expect(Array.from(await store.get(key))).toEqual([9]);
    });

    it("rejects get of an absent key", async () => {
      const store = await makeStore();
      const { key } = freshKey();
      await expect(store.get(key)).rejects.toThrow();
    });

    it("removes a stored artifact", async () => {
      const store = await makeStore();
      const { key } = freshKey();
      await store.put(key, new Uint8Array([1]));
      await store.remove(key);
      await expect(store.get(key)).rejects.toThrow();
    });

    it("remove tolerates absence", async () => {
      const store = await makeStore();
      const { key } = freshKey();
      await expect(store.remove(key)).resolves.toBeUndefined();
    });

    it("removeEnvironment takes every key under the environment and nothing else", async () => {
      const store = await makeStore();
      const environmentId = randomUUID();
      const keyA = buildArtifactKey(environmentId, randomUUID());
      const keyB = buildArtifactKey(environmentId, randomUUID());
      const other = freshKey();
      await store.put(keyA, new Uint8Array([1]));
      await store.put(keyB, new Uint8Array([2]));
      await store.put(other.key, new Uint8Array([3]));

      await store.removeEnvironment(environmentId);

      await expect(store.get(keyA)).rejects.toThrow();
      await expect(store.get(keyB)).rejects.toThrow();
      expect(Array.from(await store.get(other.key))).toEqual([3]);
    });

    it("removeEnvironment tolerates an environment with no artifacts", async () => {
      const store = await makeStore();
      await expect(
        store.removeEnvironment(randomUUID()),
      ).resolves.toBeUndefined();
    });

    describe("key validation happens before any I/O", () => {
      const validEnv = randomUUID();
      const validBuild = randomUUID();
      const badKeys = [
        // Traversal — the attack the uuid rules exist to make unexpressible.
        `../${validEnv}/${validBuild}.tar.gz`,
        `${validEnv}/../${validBuild}.tar.gz`,
        `${validEnv}/../../etc/passwd.tar.gz`,
        // Absolute.
        `/${validEnv}/${validBuild}.tar.gz`,
        // Not uuids.
        `not-a-uuid/${validBuild}.tar.gz`,
        `${validEnv}/not-a-uuid.tar.gz`,
        // Wrong shape: extension, extra segments, missing segments.
        `${validEnv}/${validBuild}.zip`,
        `${validEnv}/extra/${validBuild}.tar.gz`,
        validEnv,
        "",
      ];

      for (const bad of badKeys) {
        it(`rejects ${JSON.stringify(bad)} on put/get/remove`, async () => {
          const store = await makeStore();
          await expect(store.put(bad, new Uint8Array([1]))).rejects.toThrow();
          await expect(store.get(bad)).rejects.toThrow();
          await expect(store.remove(bad)).rejects.toThrow();
        });
      }

      it("rejects a non-uuid environment id on removeEnvironment", async () => {
        const store = await makeStore();
        for (const bad of ["..", "not-a-uuid", "", "../..", `/${validEnv}`]) {
          await expect(store.removeEnvironment(bad)).rejects.toThrow();
        }
      });
    });
  });
}
