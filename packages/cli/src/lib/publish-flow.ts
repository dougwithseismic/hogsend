import type { CloudClient } from "./cloud-http.js";
import { CloudError } from "./cloud-http.js";
import {
  describeCloudRefusal,
  formatRefusal,
  type RefusalContext,
} from "./cloud-refusals.js";

/**
 * The testable half of `hogsend publish`: pick the environment, upload, and
 * watch the build to a terminal state.
 *
 * Tarballing and manifest assembly live in their own modules
 * (`publish-tarball.ts`, `publish-manifest.ts`) because they are pure functions
 * of a directory; this file is the CONVERSATION, and every part of it — the
 * HTTP client, the clock, the sleep, the printing — is injected so the whole
 * refusal vocabulary and the whole status loop can be exercised with no
 * network and no waiting.
 *
 * TOKEN HYGIENE INVARIANT: the bearer lives inside the injected client. It is
 * never read, printed, or returned by anything here.
 */

/** `GET /api/cli/environments` — one row. */
export interface CloudEnvironment {
  id: string;
  name: string;
  kind: "production" | "staging" | "test";
  stackStatus: string | null;
  engineVersion: string | null;
}

export interface EnvironmentListResponse {
  organization: { id: string; name: string };
  environments: CloudEnvironment[];
}

/** `GET /api/builds/:id`. */
export interface BuildStatusResponse {
  id: string;
  environmentId: string;
  status: string;
  terminal: boolean;
  engineVersion: string | null;
  imageDigest: string | null;
  error: string | null;
  logTail: string | null;
}

export class PublishError extends Error {
  readonly verdict: "no_environment" | "refused" | "build_failed" | "timeout";
  readonly hint: string | undefined;
  /** The build's tail, when a failure produced one. */
  readonly logTail: string | undefined;

  constructor(
    verdict: PublishError["verdict"],
    message: string,
    extra: { hint?: string; logTail?: string } = {},
  ) {
    super(message);
    this.name = "PublishError";
    this.verdict = verdict;
    this.hint = extra.hint;
    this.logTail = extra.logTail;
  }
}

/**
 * Which environment a publish means.
 *
 * With `--env <name>` it is an exact name match, and a miss is a refusal that
 * NAMES what exists — the alternative, guessing at a near-match, would deploy
 * to the wrong place on a typo.
 *
 * Without it, production: first by `kind` (the authoritative field, and the one
 * the control plane keeps unique per org), then by the literal name
 * `production` as a fallback for an org whose kinds predate that rule.
 */
export function selectEnvironment(
  environments: readonly CloudEnvironment[],
  name?: string,
): CloudEnvironment {
  if (name) {
    const match = environments.find((row) => row.name === name);
    if (match) return match;
    const available = environments.map((row) => row.name).join(", ");
    throw new PublishError(
      "no_environment",
      `No environment named "${name}" in this organization.`,
      {
        hint:
          available.length > 0
            ? `Available: ${available}.`
            : "This organization has no environments yet — create one in the dashboard.",
      },
    );
  }

  const production =
    environments.find((row) => row.kind === "production") ??
    environments.find((row) => row.name === "production");
  if (production) return production;

  throw new PublishError(
    "no_environment",
    "This organization has no production environment.",
    { hint: "Pass --env <name> to choose one explicitly." },
  );
}

export interface PublishFlowDeps {
  client: CloudClient;
  emit(line: string): void;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface UploadInput {
  environmentId: string;
  archive: Uint8Array;
  manifest: unknown;
  /** Filename in the multipart part. Cosmetic; the server reads bytes. */
  filename?: string;
}

export interface UploadResult {
  buildId: string;
  status: string;
}

/** POST the tarball + manifest, translating every refusal on the way out. */
export async function uploadPublish(
  input: UploadInput,
  deps: PublishFlowDeps,
  ctx: RefusalContext,
): Promise<UploadResult> {
  const form = new FormData();
  form.set("manifest", JSON.stringify(input.manifest));
  form.set(
    "tarball",
    new File([input.archive as BlobPart], input.filename ?? "app.tar.gz", {
      type: "application/gzip",
    }),
  );

  try {
    return await deps.client.postForm<UploadResult>(
      `/api/publish/${input.environmentId}`,
      form,
    );
  } catch (error) {
    throw asPublishRefusal(error, ctx);
  }
}

/** Translate a {@link CloudError} into the refusal the terminal renders. */
export function asPublishRefusal(error: unknown, ctx: RefusalContext): unknown {
  if (!(error instanceof CloudError)) return error;
  const rendered = describeCloudRefusal(error, ctx);
  return new PublishError("refused", rendered.headline, {
    ...(rendered.hint === undefined ? {} : { hint: rendered.hint }),
  });
}

/** How often the status endpoint is asked. */
export const POLL_INTERVAL_MS = 3_000;
/** A build that has not reached a terminal state by here is reported as stuck. */
export const DEFAULT_BUILD_TIMEOUT_MS = 20 * 60_000;

export interface WatchOptions {
  buildId: string;
  timeoutMs?: number;
  intervalMs?: number;
}

/**
 * Poll a build to its terminal state, printing each status TRANSITION.
 *
 * Transitions rather than every poll, because a build takes minutes and a line
 * every three seconds is noise that hides the one line that matters. The tail
 * is printed only on failure — which is also the only time the server sends
 * one (`GET /api/builds/:id` withholds `logTail` until terminal, so a running
 * build cannot re-send 64KB on every poll).
 */
export async function watchBuild(
  options: WatchOptions,
  deps: PublishFlowDeps,
  ctx: RefusalContext,
): Promise<BuildStatusResponse> {
  const interval = options.intervalMs ?? POLL_INTERVAL_MS;
  const deadline = deps.now() + (options.timeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS);
  let seen: string | null = null;

  for (;;) {
    let build: BuildStatusResponse;
    try {
      build = await deps.client.get<BuildStatusResponse>(
        `/api/builds/${options.buildId}`,
      );
    } catch (error) {
      // A blip mid-build must not fail a deploy that is succeeding on the far
      // side; anything else is a real refusal.
      if (error instanceof CloudError && error.status === 0) {
        if (deps.now() >= deadline) {
          throw new PublishError(
            "timeout",
            `Lost contact with ${ctx.cloudHost} while watching build ${options.buildId}.`,
          );
        }
        await deps.sleep(interval);
        continue;
      }
      throw asPublishRefusal(error, ctx);
    }

    if (build.status !== seen) {
      seen = build.status;
      deps.emit(`  ${build.status}`);
    }

    if (build.terminal) return build;

    if (deps.now() >= deadline) {
      throw new PublishError(
        "timeout",
        `Build ${options.buildId} is still ${build.status} after ${Math.round((options.timeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS) / 60_000)} minutes.`,
        { hint: "Watch it in the dashboard; it may still finish." },
      );
    }

    await deps.sleep(interval);
  }
}

/**
 * Turn a terminal build into a verdict. A `succeeded` returns; anything else
 * throws, which is what makes `hogsend publish` exit nonzero on a failed build.
 */
export function assertBuildSucceeded(build: BuildStatusResponse): void {
  if (build.status === "succeeded") return;
  throw new PublishError(
    "build_failed",
    `Build ${build.id} ${build.status}${build.error ? `: ${build.error}` : "."}`,
    {
      hint: "The tail of the build log is above; the full log is on the dashboard's build page.",
      ...(build.logTail ? { logTail: build.logTail } : {}),
    },
  );
}

export { formatRefusal };
