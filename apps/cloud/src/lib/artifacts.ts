import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { env } from "../env";

/**
 * Where a publish tarball lives on disk, and the one place a stored
 * `builds.artifact_path` is turned into a real path.
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

/** Write one artifact, creating its environment directory. */
export async function writeArtifact(
  key: string,
  bytes: Uint8Array,
): Promise<string> {
  const path = resolveArtifactPath(key);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  return path;
}

/**
 * Delete one artifact, tolerating its absence.
 *
 * Two callers, both compensating:
 *  - the intake route's "a rejected upload leaves no file and no row" — the
 *    file is written before the build row is inserted (so a refused insert
 *    cannot strand a row that points at nothing), and this undoes the write;
 *  - `BuildService.transition`, retiring the tarball of a build that reached a
 *    terminal status. A finished build never reads its artifact again.
 */
export async function removeArtifact(key: string): Promise<void> {
  await rm(resolveArtifactPath(key), { force: true });
}

/**
 * Delete EVERY artifact belonging to one environment, tolerating their absence.
 *
 * The last owner of a tenant's uploaded source is the environment: once it is
 * deleted the `builds` rows cascade away, and with them the only pointers to
 * the files. Called when an environment is removed, so the source leaves with
 * it rather than living forever under an id nothing references.
 */
export async function removeEnvironmentArtifacts(
  environmentId: string,
): Promise<void> {
  if (!isUuid(environmentId)) throw new InvalidArtifactKeyError(environmentId);

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
