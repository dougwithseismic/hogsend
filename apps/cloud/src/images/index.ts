import { env } from "../env";
import { DockerImageStore } from "./docker";
import type { ImageStore } from "./types";

export { DOCKER_IMAGE_STORE_ID, DockerImageStore } from "./docker";
export type { ExecFn, ExecOptions, ExecResult } from "./exec";
export { spawnExec } from "./exec";
export { FAKE_IMAGE_STORE_ID, FakeImageStore } from "./fake";
export { defaultImageTag, tenantImageTag } from "./tags";
export type {
  BuildImageInput,
  BuildImageResult,
  ImageStore,
  PushImageInput,
  PushImageResult,
} from "./types";
export { ImageStoreError } from "./types";

/**
 * The single entry point every caller uses to reach an image registry.
 *
 * Unlike `getSubstrate()` there is no `CLOUD_IMAGE_STORE` switch: there is one
 * real implementation, and its two modes (registry-qualified vs. local-only)
 * are decided by whether `CLOUD_IMAGE_REGISTRY` is set. A missing registry is
 * NOT a reason to fall back to a fake — a fake store would report images that
 * do not exist, which is the failure the substrate seam refuses for the same
 * reason. Tests inject `FakeImageStore` directly.
 */

let singleton: ImageStore | undefined;

export function getImageStore(): ImageStore {
  singleton ??= new DockerImageStore({ registry: env.CLOUD_IMAGE_REGISTRY });
  return singleton;
}

/**
 * The reference a substrate pulls for a bare `name:tag`, WITHOUT constructing a
 * store. Provisioning needs it for `initialImage` before any build exists, and
 * `getImageStore()` would be a docker dependency in a code path that never runs
 * a command.
 */
export function qualifyImage(tag: string): string {
  const registry = env.CLOUD_IMAGE_REGISTRY?.replace(/\/+$/, "");
  return registry ? `${registry}/${tag}` : tag;
}
