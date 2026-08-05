import { type ExecFn, spawnExec } from "./exec";
import {
  type BuildImageInput,
  type BuildImageResult,
  type ImageStore,
  ImageStoreError,
  type PushImageInput,
  type PushImageResult,
} from "./types";

/**
 * The real image store: `docker build` / `docker push` on the build host.
 *
 * Two decisions are load-bearing:
 *
 *  - **`--platform linux/amd64`, always.** The substrate runs amd64; an image
 *    built on an arm64 laptop or an arm CI runner boots to `exec format error`
 *    on the first deploy and looks like a broken app. The platform is fixed
 *    here rather than left to the host so the same tarball produces the same
 *    architecture wherever the builder happens to run.
 *  - **A registry-less mode that is HONEST about it.** With no
 *    `CLOUD_IMAGE_REGISTRY` the images stay local and `push` is a no-op that
 *    says so — the local-dev posture, where the fake substrate "deploys" a tag
 *    nothing ever pulls. It still returns the local image id as the digest, so
 *    the build row records WHICH image it produced rather than a null that
 *    means nothing. A real deploy sets the registry and gets a real digest.
 *
 * `exec` is injected for the reason the whole seam exists: this class is unit
 * tested for its argv, with no docker daemon anywhere near the suite.
 */

export interface DockerImageStoreOptions {
  exec?: ExecFn;
  /** e.g. `ghcr.io/withseismic`. Absent → local-only images, no push. */
  registry?: string;
  /** The docker binary. Injectable for hosts that ship it under another name. */
  docker?: string;
  /** Operator-facing notices (registry-less push). Defaults to stderr. */
  onNotice?: (message: string) => void;
  /** Wall-clock ceiling for one docker invocation. */
  timeoutMs?: number;
}

/** A docker build of a whole app is minutes, not seconds. */
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/** `<tag>: digest: sha256:… size: …` — what `docker push` prints on success. */
const PUSH_DIGEST_PATTERN = /digest:\s*(sha256:[0-9a-zA-Z]+)/;

export const DOCKER_IMAGE_STORE_ID = "docker";

export class DockerImageStore implements ImageStore {
  readonly id = DOCKER_IMAGE_STORE_ID;

  private readonly exec: ExecFn;
  private readonly registry?: string;
  private readonly docker: string;
  private readonly notice: (message: string) => void;
  private readonly timeoutMs: number;

  constructor(options: DockerImageStoreOptions = {}) {
    this.exec = options.exec ?? spawnExec;
    // A trailing slash in the env var must not produce `ghcr.io/org//name`.
    this.registry = options.registry?.replace(/\/+$/, "") || undefined;
    this.docker = options.docker ?? "docker";
    this.notice =
      options.onNotice ??
      ((message) => {
        process.stderr.write(
          `${JSON.stringify({ service: "cloud-images", event: "notice", message })}\n`,
        );
      });
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  reference(tag: string): string {
    return this.registry ? `${this.registry}/${tag}` : tag;
  }

  async build(input: BuildImageInput): Promise<BuildImageResult> {
    const reference = this.reference(input.tag);

    // Make the build IDEMPOTENT on its tag. The exec seam can legitimately run
    // this command twice for one logical build: on the sandbox host it rides
    // the Railway GraphQL client, whose retry policy re-issues a request that
    // failed transiently even though the first `docker build` may have run to
    // completion. BuildKit's containerd store then refuses to export over the
    // existing name ("image … already exists") — seen live on build 2c970205
    // (2026-08-05), where a retried cold build failed the whole publish at the
    // export step. Removing the tag first is a no-op on the first run and
    // exactly the cleanup the retry needs; failure is ignored because a
    // missing image is the normal case.
    await this.exec(this.docker, ["image", "rm", "-f", reference], {
      timeoutMs: 60_000,
    });

    const args = [
      "build",
      // See the class doc: the substrate is amd64, whatever the builder is.
      "--platform",
      "linux/amd64",
      ...Object.entries(input.buildArgs ?? {}).flatMap(([key, value]) => [
        "--build-arg",
        `${key}=${value}`,
      ]),
      "-f",
      input.dockerfile,
      "-t",
      reference,
      input.contextDir,
    ];

    const result = await this.exec(this.docker, args, {
      onOutput: input.onOutput,
      timeoutMs: this.timeoutMs,
    });
    if (result.code !== 0) {
      throw new ImageStoreError(
        result.timedOut
          ? `docker build for ${reference} exceeded ${this.timeoutMs}ms`
          : `docker build for ${reference} exited ${result.code}`,
        result.output,
      );
    }
    return { reference };
  }

  async push(input: PushImageInput): Promise<PushImageResult> {
    const reference = this.reference(input.tag);

    if (!this.registry) {
      this.notice(
        `CLOUD_IMAGE_REGISTRY is not set — keeping "${reference}" local and skipping the push. A deploy that has to pull this image will fail; set CLOUD_IMAGE_REGISTRY to publish it.`,
      );
      return {
        reference,
        digest: await this.localImageId(reference),
        pushed: false,
      };
    }

    const result = await this.exec(this.docker, ["push", reference], {
      onOutput: input.onOutput,
      timeoutMs: this.timeoutMs,
    });
    if (result.code !== 0) {
      throw new ImageStoreError(
        result.timedOut
          ? `docker push for ${reference} exceeded ${this.timeoutMs}ms`
          : `docker push for ${reference} exited ${result.code}`,
        result.output,
      );
    }
    return {
      reference,
      digest: PUSH_DIGEST_PATTERN.exec(result.output)?.[1] ?? null,
      pushed: true,
    };
  }

  /** The local content id — the registry-less stand-in for a push digest. */
  private async localImageId(reference: string): Promise<string | null> {
    const result = await this.exec(
      this.docker,
      ["image", "inspect", "--format", "{{.Id}}", reference],
      { timeoutMs: this.timeoutMs },
    );
    if (result.code !== 0) return null;
    const id = result.output.trim().split("\n").at(-1)?.trim();
    return id?.startsWith("sha256:") ? id : null;
  }
}
