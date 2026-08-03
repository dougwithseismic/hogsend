import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  type GetObjectCommandOutput,
  ListObjectsV2Command,
  type ListObjectsV2CommandOutput,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { artifactBucketConfig, env } from "../env";

/**
 * Where a publish tarball lives, and the one place a stored
 * `builds.artifact_path` is turned into something real.
 *
 * Storage is behind the `ArtifactStore` seam (PRD 14): the upload is received
 * by `cloud-app` and the build executes on `cloud-worker`, so the backing
 * store must be swappable for one both containers can reach. Local disk is
 * the default and the dev/CI path; an object-store implementation selects on
 * configuration (task 2).
 *
 * Two decisions worth stating:
 *
 *  - **The row stores a KEY, not a path.** `<environmentId>/<buildId>.tar.gz`
 *    is relative to `CLOUD_ARTIFACTS_DIR`, so moving the volume (dev laptop →
 *    build host → a different mount point) does not invalidate every build
 *    record ever written. Only this module knows where the root is.
 *
 *  - **Both components are uuids, and that is CHECKED.** The environment id
 *    arrives in a URL and the build id is generated here; a key is built only
 *    from values that match the uuid shape, and `resolveArtifactPath` re-checks
 *    that the resolved path is still inside the root. A path is therefore never
 *    assembled from anything a caller could shape into `..`.
 */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The extension every artifact carries — the CLI uploads gzipped tar. */
export const ARTIFACT_EXTENSION = ".tar.gz";

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** Raised when a key or a component could not be trusted to build a path. */
export class InvalidArtifactKeyError extends Error {
  readonly code = "invalid_artifact_key";

  constructor(readonly key: string) {
    super(`"${key}" is not a valid artifact key`);
    this.name = "InvalidArtifactKeyError";
  }
}

/** The configured root, absolute. Read per call so a test can repoint it. */
export function artifactsRoot(): string {
  return resolve(env.CLOUD_ARTIFACTS_DIR);
}

/**
 * The storage key for one build's tarball. Throws unless BOTH ids are uuids —
 * this is the check that makes every later `join` safe.
 */
export function buildArtifactKey(
  environmentId: string,
  buildId: string,
): string {
  if (!isUuid(environmentId) || !isUuid(buildId)) {
    throw new InvalidArtifactKeyError(`${environmentId}/${buildId}`);
  }
  return `${environmentId}/${buildId}${ARTIFACT_EXTENSION}`;
}

/**
 * Validate a stored key back into its components. THE key check every store
 * shares: a key read back from the database is still an input, so both
 * implementations re-validate rather than trusting the row — on local disk a
 * bad key would be a path, on S3 an object name, and the refusal posture must
 * be identical either way.
 */
export function parseArtifactKey(key: string): {
  environmentId: string;
  buildId: string;
} {
  if (isAbsolute(key)) throw new InvalidArtifactKeyError(key);

  const [environmentId, file, ...rest] = key.split("/");
  if (!environmentId || !file || rest.length > 0) {
    throw new InvalidArtifactKeyError(key);
  }
  if (!file.endsWith(ARTIFACT_EXTENSION))
    throw new InvalidArtifactKeyError(key);
  const buildId = file.slice(0, -ARTIFACT_EXTENSION.length);
  if (!isUuid(environmentId) || !isUuid(buildId)) {
    throw new InvalidArtifactKeyError(key);
  }
  return { environmentId, buildId };
}

/**
 * Absolute path for a stored key, for the local-disk store. Validates via
 * `parseArtifactKey`, then re-checks that the resolved path is still inside
 * the root — the containment check is what turns "a bad row" into an error
 * instead of a write outside the root.
 */
export function resolveArtifactPath(key: string): string {
  parseArtifactKey(key);

  const root = artifactsRoot();
  const path = resolve(join(root, key));
  // Belt to the uuid braces: whatever the components were, the result must
  // still be under the root.
  if (path !== root && !path.startsWith(root + sep)) {
    throw new InvalidArtifactKeyError(key);
  }
  return path;
}

/**
 * The storage seam every artifact byte crosses (PRD 14).
 *
 * Keys are the SAME `<environmentId>/<buildId>.tar.gz` values the rows store,
 * and every implementation validates them by the same uuid rules before any
 * I/O — on an object store a bad key is an object name rather than a
 * filesystem path, but the posture is identical.
 */
export interface ArtifactStore {
  /** Store one artifact under its key, overwriting any previous bytes. */
  put(key: string, bytes: Uint8Array): Promise<void>;
  /** The stored bytes for a key. Rejects when the artifact is absent. */
  get(key: string): Promise<Uint8Array>;
  /**
   * Delete one artifact, tolerating its absence.
   *
   * Two callers, both compensating:
   *  - the intake route's "a rejected upload leaves no file and no row" — the
   *    file is written before the build row is inserted (so a refused insert
   *    cannot strand a row that points at nothing), and this undoes the write;
   *  - `BuildService.transition`, retiring the tarball of a build that reached
   *    a terminal status. A finished build never reads its artifact again.
   */
  remove(key: string): Promise<void>;
  /**
   * Delete EVERY artifact belonging to one environment, tolerating their
   * absence.
   *
   * The last owner of a tenant's uploaded source is the environment: once it
   * is deleted the `builds` rows cascade away, and with them the only pointers
   * to the files. Called when an environment is removed, so the source leaves
   * with it rather than living forever under an id nothing references.
   */
  removeEnvironment(environmentId: string): Promise<void>;
}

/**
 * How long a presigned artifact download URL stays valid. Short on purpose:
 * the URL is a bearer credential for one tenant's uploaded source, minted
 * moments before the sandbox `curl`s it — fifteen minutes covers a slow
 * store-fetch-and-extract on the worker side with margin, and nothing more.
 */
export const PRESIGNED_ARTIFACT_URL_TTL_SECONDS = 15 * 60;

/**
 * The OPTIONAL presigning capability (PRD 14 task 3). A capability interface
 * rather than an `ArtifactStore` method because presigning is an object-store
 * fact, not a storage fact: a local-disk path has no URL a sandbox could
 * fetch, and a local store that "implemented" this by throwing would turn a
 * configuration error into a mid-build surprise. Callers narrow with
 * {@link supportsPresignedDownload} and refuse loudly when it is absent.
 */
export interface PresignedDownloadCapable {
  /** A time-limited GET URL for one stored artifact. The URL is a secret. */
  presignArtifactDownload(
    key: string,
    expiresInSeconds?: number,
  ): Promise<string>;
}

export function supportsPresignedDownload(
  store: ArtifactStore,
): store is ArtifactStore & PresignedDownloadCapable {
  return (
    typeof (store as Partial<PresignedDownloadCapable>)
      .presignArtifactDownload === "function"
  );
}

/**
 * The store today's deployments actually run: files under
 * `CLOUD_ARTIFACTS_DIR`, exactly as the pre-seam free functions wrote them.
 * Every path it touches goes through `resolveArtifactPath`, so the uuid rules
 * and the containment belt hold for reads the same as writes.
 */
export class LocalDiskArtifactStore implements ArtifactStore {
  async put(key: string, bytes: Uint8Array): Promise<void> {
    const path = resolveArtifactPath(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }

  async get(key: string): Promise<Uint8Array> {
    return await readFile(resolveArtifactPath(key));
  }

  async remove(key: string): Promise<void> {
    await rm(resolveArtifactPath(key), { force: true });
  }

  async removeEnvironment(environmentId: string): Promise<void> {
    if (!isUuid(environmentId)) {
      throw new InvalidArtifactKeyError(environmentId);
    }

    const root = artifactsRoot();
    const dir = resolve(join(root, environmentId));
    // The uuid check already makes traversal impossible; this is the same belt
    // `resolveArtifactPath` wears, because the cost of being wrong here is an
    // `rm -r` outside the artifacts tree.
    if (!dir.startsWith(root + sep)) {
      throw new InvalidArtifactKeyError(environmentId);
    }
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The one method this module uses from `S3Client`, as a structural seam.
 *
 * The real client satisfies it (method position keeps the parameter
 * bivariant), and a test double implementing just these commands can stand in
 * without mocking the SDK module — which is how the contract suite proves the
 * pagination and not-found paths against real command objects.
 */
export interface S3ClientLike {
  send(command: unknown): Promise<unknown>;
}

/**
 * "This object is not there" in the several shapes the S3 API says it:
 * `NoSuchKey` on a get, `NotFound` on a head, a bare 404 from an
 * S3-compatible endpoint that names neither. Only `remove` tolerates these —
 * a get of a missing artifact stays an error.
 */
function isS3NotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { name, $metadata } = error as {
    name?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  return (
    name === "NoSuchKey" ||
    name === "NotFound" ||
    $metadata?.httpStatusCode === 404
  );
}

/**
 * The production store (PRD 14): artifacts as objects in an S3-compatible
 * bucket, keys unchanged. This is what lets an upload received by cloud-app
 * be read by a build executing on cloud-worker — two containers with no
 * shared filesystem, one bucket.
 *
 * Every key is validated by `parseArtifactKey` BEFORE any request leaves the
 * process: a bad key here is an object name rather than a filesystem path,
 * but the refusal posture is identical to the local store's.
 */
export class S3ArtifactStore
  implements ArtifactStore, PresignedDownloadCapable
{
  private readonly client: S3ClientLike;
  private readonly bucket: string;
  private readonly presign: (
    client: S3ClientLike,
    command: GetObjectCommand,
    expiresInSeconds: number,
  ) => Promise<string>;

  constructor(opts: {
    client: S3ClientLike;
    bucket: string;
    /**
     * Injectable so the contract suite proves key validation and TTL wiring
     * without a real signing config. The default is the SDK's signer, which
     * needs the REAL `S3Client` (it reads credentials and endpoint off the
     * client's config) — the cast is safe because the default is only ever
     * paired with the real client `buildConfiguredStore` constructs.
     */
    presign?: (
      client: S3ClientLike,
      command: GetObjectCommand,
      expiresInSeconds: number,
    ) => Promise<string>;
  }) {
    this.client = opts.client;
    this.bucket = opts.bucket;
    this.presign =
      opts.presign ??
      ((client, command, expiresIn) =>
        getSignedUrl(client as S3Client, command, { expiresIn }));
  }

  /** See {@link PresignedDownloadCapable}. Same key refusal as every other
   * operation, BEFORE any signing — a bad key must never become a URL. */
  async presignArtifactDownload(
    key: string,
    expiresInSeconds: number = PRESIGNED_ARTIFACT_URL_TTL_SECONDS,
  ): Promise<string> {
    parseArtifactKey(key);
    return await this.presign(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      expiresInSeconds,
    );
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    parseArtifactKey(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bytes,
        ContentType: "application/gzip",
      }),
    );
  }

  async get(key: string): Promise<Uint8Array> {
    parseArtifactKey(key);
    const response = (await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    )) as GetObjectCommandOutput;
    // A 200 with no body is not a thing S3 does, but "some bytes" is this
    // method's whole contract — refuse rather than hand back an empty
    // artifact a build would then fail on less legibly.
    if (!response.Body) {
      throw new Error(`artifact "${key}" came back with no body`);
    }
    return await response.Body.transformToByteArray();
  }

  async remove(key: string): Promise<void> {
    parseArtifactKey(key);
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
      );
    } catch (error) {
      // Both callers are best-effort compensations (see the interface); an
      // already-gone object is their success case, not a failure. Anything
      // that is not a not-found still throws.
      if (!isS3NotFound(error)) throw error;
    }
  }

  async removeEnvironment(environmentId: string): Promise<void> {
    if (!isUuid(environmentId)) {
      throw new InvalidArtifactKeyError(environmentId);
    }

    // List → delete, page by page, until the listing is exhausted. The loop
    // matters: ListObjectsV2 caps a page at 1000 keys, so an environment with
    // many builds is only fully cleared if every continuation is followed.
    let continuationToken: string | undefined;
    do {
      const page = (await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: `${environmentId}/`,
          ContinuationToken: continuationToken,
        }),
      )) as ListObjectsV2CommandOutput;

      const keys = (page.Contents ?? []).flatMap((object) =>
        object.Key ? [{ Key: object.Key }] : [],
      );
      if (keys.length > 0) {
        await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: keys, Quiet: true },
          }),
        );
      }

      continuationToken = page.IsTruncated
        ? page.NextContinuationToken
        : undefined;
    } while (continuationToken);
  }
}

/**
 * The active store, resolved lazily on first use and held for the process.
 *
 * A module-level singleton rather than per-call construction so "which store
 * is this deployment running" is answered exactly once. The choice is the
 * configuration's: a complete bucket set selects S3, none selects local disk,
 * and the in-between cases are refused before this ever runs —
 * `artifactBucketConfig` throws on a partial set, and `src/env.ts` refuses a
 * production boot with no bucket at all.
 */
let activeStore: ArtifactStore | undefined;

export function getArtifactStore(): ArtifactStore {
  activeStore ??= buildConfiguredStore();
  return activeStore;
}

function buildConfiguredStore(): ArtifactStore {
  const bucket = artifactBucketConfig();
  if (!bucket) return new LocalDiskArtifactStore();
  return new S3ArtifactStore({
    client: new S3Client({
      endpoint: bucket.endpoint,
      region: bucket.region,
      credentials: {
        accessKeyId: bucket.accessKeyId,
        secretAccessKey: bucket.secretAccessKey,
      },
      // Virtual-host addressing (`bucket.endpoint/key`), NOT path-style.
      // Read from a real Railway Bucket rather than assumed: its credentials
      // payload reports `urlStyle: "virtual-host"` and `region: "auto"`. The
      // SDK's default is virtual-host, so this is stated rather than set —
      // the comment is the point, because the opposite guess fails only on
      // the first real upload.
      forcePathStyle: false,
    }),
    bucket: bucket.bucket,
  });
}

/**
 * Substitute the active store — tests only. `undefined` restores the default
 * resolution on next `getArtifactStore()`.
 */
export function setArtifactStore(store: ArtifactStore | undefined): void {
  activeStore = store;
}
