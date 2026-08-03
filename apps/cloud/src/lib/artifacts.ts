import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { env } from "../env";

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
 * Absolute path for a stored key. Re-validates rather than trusting the row: a
 * key read back from the database is still an input, and the containment check
 * is what turns "a bad row" into an error instead of a write outside the root.
 */
export function resolveArtifactPath(key: string): string {
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
 * The active store, resolved lazily on first use and held for the process.
 *
 * A module-level singleton rather than per-call construction so "which store
 * is this deployment running" is answered exactly once — the place task 2's
 * configuration switch (and production's local-store refusal) will live.
 */
let activeStore: ArtifactStore | undefined;

export function getArtifactStore(): ArtifactStore {
  activeStore ??= new LocalDiskArtifactStore();
  return activeStore;
}

/**
 * Substitute the active store — tests only. `undefined` restores the default
 * resolution on next `getArtifactStore()`.
 */
export function setArtifactStore(store: ArtifactStore | undefined): void {
  activeStore = store;
}
