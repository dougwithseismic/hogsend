/**
 * THE image seam (PRD 08 task 3).
 *
 * Everything the build pipeline does to a container image goes through
 * `ImageStore`. Same one-directional-ignorance rule as `SubstrateProvider`: the
 * pipeline never learns that images are built by docker, tagged by a registry
 * prefix, or pushed with a credential — it asks for a reference and gets one.
 *
 * The interface is small on purpose. Two verbs (build, push) plus the one pure
 * function that turns a bare `name:tag` into the reference a substrate
 * can actually pull. Anything else — layer caching, scanning, garbage
 * collection — is an implementation's business, not a caller's.
 */

export interface BuildImageInput {
  /** Absolute path to the docker build context. */
  contextDir: string;
  /** Absolute path to the Dockerfile. May live outside `contextDir`. */
  dockerfile: string;
  /** A bare `name:tag`. Registry qualification is the store's job. */
  tag: string;
  buildArgs?: Record<string, string>;
  /** Build output, as it arrives. The build log tail is assembled from this. */
  onOutput?: (chunk: string) => void;
}

export interface BuildImageResult {
  /** The fully-qualified reference the image now carries. */
  reference: string;
}

export interface PushImageInput {
  tag: string;
  onOutput?: (chunk: string) => void;
}

export interface PushImageResult {
  reference: string;
  /**
   * `sha256:…`. The REGISTRY digest after a real push; the local image id when
   * the store is running registry-less (dev). Null when neither is knowable.
   */
  digest: string | null;
  /** False when the store is local-only and the push was a deliberate no-op. */
  pushed: boolean;
}

export interface ImageStore {
  /** `"docker"`, `"fake"`, … — named in logs and audit detail. */
  readonly id: string;
  /** The reference a substrate would pull for this bare `name:tag`. */
  reference(tag: string): string;
  build(input: BuildImageInput): Promise<BuildImageResult>;
  push(input: PushImageInput): Promise<PushImageResult>;
}

/**
 * The only error type that crosses the seam. `output` carries the tail of what
 * the tool actually said — a build failure is diagnosed from its log, and
 * losing it to a tidy message would make every failure identical.
 */
export class ImageStoreError extends Error {
  constructor(
    message: string,
    readonly output = "",
  ) {
    super(output ? `${message}\n${output}` : message);
    this.name = "ImageStoreError";
  }
}
