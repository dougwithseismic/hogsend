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
  /**
   * The STACK's phase, alongside the build's (PRD 15). Optional because a
   * cloud older than that release does not send it, and a CLI that required it
   * would break against one.
   *
   * It exists because the build status alone cannot describe the opening
   * minutes of a FIRST publish: the build sits in `building` while the
   * substrate it will deploy onto is still being created, and "building" for
   * four minutes with no further output reads as a hang.
   */
  stack?: { status: string } | null;
}

export class PublishError extends Error {
  readonly verdict:
    | "no_environment"
    | "refused"
    | "build_failed"
    | "provisioning_failed"
    | "timeout";
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

/**
 * What each provisioning phase reads like — the phases a first publish passes
 * through before there is anything to deploy onto (PRD 15). These keys are the
 * membership test too. `publishing` is deliberately absent: that is the stack
 * RECEIVING this build, which is the deploy step and belongs to the build
 * narrative. `running` is absent because it is the destination, not a phase.
 *
 * Deliberately worded so it cannot be mistaken for a build phase — the build
 * prints bare status words (`building`, `pushing`), and these are sentences
 * about the INSTANCE. Somebody watching should never have to work out which of
 * the two machines a line came from.
 */
const PROVISIONING_LINES: Record<string, string> = {
  deferred: "preparing your instance — this is its first publish",
  requested: "provisioning your instance (a few minutes on a first publish)",
  provisioning: "provisioning your instance — creating database, workers, DNS",
};

/**
 * The stack statuses that mean "your instance is being built", derived from
 * the renderer above so the two cannot disagree about which is which.
 *
 * Exported because `@hogsend/mcp`'s `derivePhase` needs the same set to report
 * a `provisioning` phase; it renders its own wording for an agent, but the
 * membership question has one answer.
 *
 * AUTHORITATIVE LIST LIVES IN THE CONTROL PLANE: `STACK_WAIT_STATUSES` in
 * `apps/cloud/src/pipeline/build.ts` decides what the BUILD is willing to wait
 * for, and a status it waits on that is missing here would render as a stalled
 * build rather than a provisioning one. Different package, no import — so if
 * one changes, change both.
 */
export const PROVISIONING_STACK_STATUSES: ReadonlySet<string> = new Set(
  Object.keys(PROVISIONING_LINES),
);

/** How often the status endpoint is asked. */
export const POLL_INTERVAL_MS = 3_000;
/** A build that has not reached a terminal state by here is reported as stuck. */
export const DEFAULT_BUILD_TIMEOUT_MS = 20 * 60_000;

/**
 * And the ceiling on the provisioning that PRECEDES a first build. Matches the
 * cloud's own bounded wait (`pipeline/build.ts`), so the CLI gives up at the
 * same moment the server does rather than reporting a hang the server was
 * about to resolve — or, worse, giving up first and leaving a build that then
 * succeeds unnoticed.
 */
export const DEFAULT_PROVISION_TIMEOUT_MS = 20 * 60_000;

export interface WatchOptions {
  buildId: string;
  timeoutMs?: number;
  intervalMs?: number;
  /**
   * Ceiling on the PROVISIONING phases, counted separately from the build's.
   *
   * They are two different waits and adding them into one number would be
   * wrong in both directions: a first publish would trip the build timeout
   * before it had built anything, and raising the single number would let a
   * genuinely stuck build run twice as long. The build's own clock starts when
   * the instance is ready.
   */
  provisionTimeoutMs?: number;
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
  const buildTimeout = options.timeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS;
  const provisionTimeout =
    options.provisionTimeoutMs ?? DEFAULT_PROVISION_TIMEOUT_MS;
  let deadline = deps.now() + buildTimeout;
  let seen: string | null = null;
  let seenStack: string | null = null;
  /**
   * True while the instance itself is still being created. Doubles as "did we
   * ever provision?" — the handoff below reads it BEFORE clearing it, so a
   * publish onto an already-running stack (which never set it) prints no
   * handoff line, and one that waited prints exactly one.
   */
  let provisioning = false;

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

    // The STACK first, because while it is being created the build's own
    // status is standing still and says nothing useful. One line per PHASE, as
    // with build statuses: a line every three seconds hides the one that
    // matters.
    const stackStatus = build.stack?.status ?? null;
    if (stackStatus !== null && stackStatus !== seenStack) {
      const line = PROVISIONING_LINES[stackStatus];
      if (line) {
        // The build's clock has not started yet — see `provisionTimeoutMs`.
        provisioning = true;
        deadline = deps.now() + provisionTimeout;
        deps.emit(`  ${line}`);
      } else if (provisioning && stackStatus === "running") {
        // The handoff, printed ONCE and only for a publish that actually
        // waited: it is the moment the narrative moves from "your instance"
        // to "your code", and without it the build phases below look like
        // they restarted.
        deps.emit("  instance ready — deploying your app");
        // The build's own ceiling starts HERE, so a publish that waited ten
        // minutes for substrate still gets a full build window.
        provisioning = false;
        deadline = deps.now() + buildTimeout;
      }
      seenStack = stackStatus;
    }

    // A stack that PARKED is not a slow stack. The build's own precheck
    // refuses an undriven status too, so this is the same verdict a few
    // minutes earlier and with a sentence the build log cannot give.
    if (stackStatus === "error") {
      throw new PublishError(
        "provisioning_failed",
        `Provisioning failed for this environment, so build ${options.buildId} has nothing to deploy onto.`,
        {
          hint: "We have been alerted. Check the environment page for the failed step, or publish again once it reports running.",
        },
      );
    }

    // While the INSTANCE is being created the build's own status is not news:
    // it says `building` because it is sitting in its precheck waiting for
    // substrate, and printing that between two provisioning lines makes the
    // narrative read as two things happening at once when only one is. Held
    // back (and not recorded as seen) so it prints on the first poll AFTER the
    // handoff, where it is true.
    if (!provisioning && build.status !== seen) {
      seen = build.status;
      deps.emit(`  ${build.status}`);
    }

    if (build.terminal) return build;

    if (deps.now() >= deadline) {
      // Which of the two waits ran out decides the sentence: "your build is
      // slow" and "your instance never came up" send a reader to different
      // pages, and only one of them is about their code.
      throw provisioning
        ? new PublishError(
            "timeout",
            `This environment is still being provisioned after ${Math.round(provisionTimeout / 60_000)} minutes.`,
            {
              hint: "Provisioning continues without you — check the environment page, then publish again once it reports running.",
            },
          )
        : new PublishError(
            "timeout",
            `Build ${options.buildId} is still ${build.status} after ${Math.round(buildTimeout / 60_000)} minutes.`,
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
