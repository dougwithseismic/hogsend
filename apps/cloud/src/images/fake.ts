import { createHash } from "node:crypto";
import type {
  BuildImageInput,
  BuildImageResult,
  ImageStore,
  PushImageInput,
  PushImageResult,
} from "./types";

/**
 * The in-memory image store: every build-pipeline test, and local dev with no
 * docker.
 *
 * DETERMINISTIC by construction, the same way `FakeSubstrate` is: a digest is a
 * pure sha256 of the reference, so a test asserting one is asserting a fact
 * rather than recording a sample, and two runs of the same build agree.
 *
 * Two test affordances, and only these:
 *  - `failNext(method, error?)` scripts the NEXT call to throw. "Preflight
 *    failure deploys nothing" and "a push failure never reaches the substrate"
 *    are rules that can only be proved by failing on cue.
 *  - `calls` records `{ method, input }` in order, so a test can assert the
 *    strong thing — "push was never called" — rather than only the end state.
 */

export type FakeImageStoreMethod = "build" | "push";

export interface FakeImageStoreCall {
  method: FakeImageStoreMethod;
  input: { tag: string; contextDir?: string; dockerfile?: string };
}

export const FAKE_IMAGE_STORE_ID = "fake";

export class FakeImageStore implements ImageStore {
  readonly id = FAKE_IMAGE_STORE_ID;

  /** Every call made, in order. */
  readonly calls: FakeImageStoreCall[] = [];
  /** References this store has "built". */
  readonly built = new Set<string>();
  /** References this store has "pushed". */
  readonly pushed = new Set<string>();

  private readonly failures = new Map<FakeImageStoreMethod, Error[]>();

  constructor(private readonly registry?: string) {}

  /** Script the NEXT call to `method` to throw. Queues. */
  failNext(method: FakeImageStoreMethod, error?: Error): this {
    const queue = this.failures.get(method) ?? [];
    queue.push(
      error ?? new Error(`fake image store: scripted ${method} failure`),
    );
    this.failures.set(method, queue);
    return this;
  }

  /** The digest this store WOULD report for a reference. Pure. */
  digestFor(reference: string): string {
    return `sha256:${createHash("sha256").update(reference).digest("hex")}`;
  }

  reference(tag: string): string {
    return this.registry ? `${this.registry}/${tag}` : tag;
  }

  async build(input: BuildImageInput): Promise<BuildImageResult> {
    this.record("build", {
      tag: input.tag,
      contextDir: input.contextDir,
      dockerfile: input.dockerfile,
    });
    const reference = this.reference(input.tag);
    input.onOutput?.(`fake: built ${reference}\n`);
    this.built.add(reference);
    return { reference };
  }

  async push(input: PushImageInput): Promise<PushImageResult> {
    this.record("push", { tag: input.tag });
    const reference = this.reference(input.tag);
    input.onOutput?.(`fake: pushed ${reference}\n`);
    this.pushed.add(reference);
    return { reference, digest: this.digestFor(reference), pushed: true };
  }

  /**
   * Log the call, THEN honour a scripted failure — a test asserting "the push
   * was attempted and failed" needs the attempt in the log, not just its
   * absence.
   */
  private record(
    method: FakeImageStoreMethod,
    input: FakeImageStoreCall["input"],
  ): void {
    this.calls.push({ method, input });
    const failure = this.failures.get(method)?.shift();
    if (failure) throw failure;
  }
}
