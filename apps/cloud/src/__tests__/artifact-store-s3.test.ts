import { randomUUID } from "node:crypto";
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import type { S3ClientLike } from "../lib/artifacts";
import {
  buildArtifactKey,
  LocalDiskArtifactStore,
  PRESIGNED_ARTIFACT_URL_TTL_SECONDS,
  S3ArtifactStore,
  supportsPresignedDownload,
} from "../lib/artifacts";
import { describeArtifactStoreContract } from "./helpers/artifact-store-contract";

/**
 * The S3 `ArtifactStore` (PRD 14 task 2), run through the shared contract
 * suite against an IN-MEMORY fake of the one client method the store uses —
 * a fake rather than a module mock on purpose, because it receives the real
 * command objects and can therefore prove the behaviours a mock would only
 * assert: pagination is actually followed, a not-found delete is actually
 * tolerated, and a bad key sends NOTHING over the wire.
 */

/** An S3-shaped not-found, as the SDK raises it. */
function noSuchKey(key: string): Error {
  return Object.assign(new Error(`NoSuchKey: ${key}`), {
    name: "NoSuchKey",
    $metadata: { httpStatusCode: 404 },
  });
}

/**
 * The slice of `S3Client` the store touches, over a Map. Two deliberate
 * severities beyond the real service:
 *
 *  - `DeleteObject` of an absent key THROWS `NoSuchKey` (real S3 answers 204)
 *    so the contract's "remove tolerates absence" proves the store's
 *    tolerance rather than the backend's;
 *  - the list page size is constructor-tunable, so a small page forces
 *    `removeEnvironment` through real continuation tokens.
 */
class FakeS3Client implements S3ClientLike {
  readonly objects = new Map<string, Uint8Array>();
  sends = 0;
  listCalls = 0;
  deleteBatchCalls = 0;

  constructor(private readonly pageSize = 1000) {}

  async send(command: unknown): Promise<unknown> {
    this.sends += 1;

    if (command instanceof PutObjectCommand) {
      const { Key, Body } = command.input;
      this.objects.set(String(Key), new Uint8Array(Body as Uint8Array));
      return {};
    }

    if (command instanceof GetObjectCommand) {
      const key = String(command.input.Key);
      const bytes = this.objects.get(key);
      if (!bytes) throw noSuchKey(key);
      return { Body: { transformToByteArray: async () => bytes } };
    }

    if (command instanceof DeleteObjectCommand) {
      const key = String(command.input.Key);
      if (!this.objects.has(key)) throw noSuchKey(key);
      this.objects.delete(key);
      return {};
    }

    if (command instanceof ListObjectsV2Command) {
      this.listCalls += 1;
      const { Prefix, ContinuationToken } = command.input;
      const all = [...this.objects.keys()]
        .filter((key) => key.startsWith(String(Prefix ?? "")))
        .sort();
      // The token cursors by KEY, as the real service does — an index-based
      // token would drift when the caller deletes between pages, and the
      // whole point of this fake is proving delete-as-you-go pagination.
      const after = ContinuationToken
        ? all.filter((key) => key > String(ContinuationToken))
        : all;
      const page = after.slice(0, this.pageSize);
      const truncated = after.length > this.pageSize;
      return {
        Contents: page.map((key) => ({ Key: key })),
        IsTruncated: truncated,
        NextContinuationToken: truncated ? page[page.length - 1] : undefined,
      };
    }

    if (command instanceof DeleteObjectsCommand) {
      this.deleteBatchCalls += 1;
      for (const object of command.input.Delete?.Objects ?? []) {
        this.objects.delete(String(object.Key));
      }
      return {};
    }

    throw new Error(`FakeS3Client: unexpected command ${String(command)}`);
  }
}

const BUCKET = "hogsend-artifacts-test";

function makeStore(pageSize?: number): {
  store: S3ArtifactStore;
  client: FakeS3Client;
} {
  const client = new FakeS3Client(pageSize);
  return { store: new S3ArtifactStore({ client, bucket: BUCKET }), client };
}

describeArtifactStoreContract("S3ArtifactStore", () => makeStore().store);

describe("S3ArtifactStore — object-store behaviour", () => {
  it("rejects a bad key before ANY request reaches the client", async () => {
    const { store, client } = makeStore();
    const bad = "../etc/passwd.tar.gz";
    await expect(store.put(bad, new Uint8Array([1]))).rejects.toThrow();
    await expect(store.get(bad)).rejects.toThrow();
    await expect(store.remove(bad)).rejects.toThrow();
    await expect(store.removeEnvironment("not-a-uuid")).rejects.toThrow();
    expect(client.sends).toBe(0);
  });

  it("removeEnvironment follows continuation tokens across every page", async () => {
    // Page size 2 with five artifacts forces three list pages — the loop the
    // real 1000-key page cap makes invisible until an environment is big.
    const { store, client } = makeStore(2);
    const environmentId = randomUUID();
    for (let i = 0; i < 5; i += 1) {
      await store.put(
        buildArtifactKey(environmentId, randomUUID()),
        new Uint8Array([i]),
      );
    }
    const survivor = buildArtifactKey(randomUUID(), randomUUID());
    await store.put(survivor, new Uint8Array([9]));

    await store.removeEnvironment(environmentId);

    expect(client.listCalls).toBe(3);
    expect(client.deleteBatchCalls).toBe(3);
    expect([...client.objects.keys()]).toEqual([survivor]);
  });

  it("rethrows a non-not-found error from remove", async () => {
    const failing: S3ClientLike = {
      send: async () => {
        throw Object.assign(new Error("AccessDenied"), {
          name: "AccessDenied",
          $metadata: { httpStatusCode: 403 },
        });
      },
    };
    const store = new S3ArtifactStore({ client: failing, bucket: BUCKET });
    await expect(
      store.remove(buildArtifactKey(randomUUID(), randomUUID())),
    ).rejects.toThrow("AccessDenied");
  });
});

describe("S3ArtifactStore — presigned downloads (PRD 14 task 3)", () => {
  it("presigns by key with the short default TTL", async () => {
    const client = new FakeS3Client();
    const signed: { key: string; expiresIn: number }[] = [];
    const store = new S3ArtifactStore({
      client,
      bucket: BUCKET,
      presign: async (_client, command, expiresIn) => {
        signed.push({ key: String(command.input.Key), expiresIn });
        return `https://signed.example/${command.input.Key}`;
      },
    });
    const key = buildArtifactKey(randomUUID(), randomUUID());
    const url = await store.presignArtifactDownload(key);
    expect(url).toBe(`https://signed.example/${key}`);
    expect(signed).toEqual([
      { key, expiresIn: PRESIGNED_ARTIFACT_URL_TTL_SECONDS },
    ]);
    // Short by design: the URL is a bearer credential for tenant source.
    expect(PRESIGNED_ARTIFACT_URL_TTL_SECONDS).toBeLessThanOrEqual(15 * 60);
  });

  it("rejects a bad key before any signing happens", async () => {
    let signs = 0;
    const store = new S3ArtifactStore({
      client: new FakeS3Client(),
      bucket: BUCKET,
      presign: async () => {
        signs += 1;
        return "https://never";
      },
    });
    await expect(
      store.presignArtifactDownload("../etc/passwd.tar.gz"),
    ).rejects.toThrow();
    expect(signs).toBe(0);
  });

  it("only the S3 store claims the capability — local disk does not", () => {
    expect(supportsPresignedDownload(makeStore().store)).toBe(true);
    expect(supportsPresignedDownload(new LocalDiskArtifactStore())).toBe(false);
  });
});
