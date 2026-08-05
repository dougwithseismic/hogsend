import {
  type CloudError,
  describeCloudRefusal,
  EmailLoginError,
  isCloudError,
  NotLoggedInError,
  PublishError,
  ScaffoldError,
} from "@hogsend/cli/cloud";

/**
 * The cloud tools' failure vocabulary.
 *
 * The `cloud_*` tools talk to the CONTROL PLANE, not to the admin API, so they
 * cannot use `mapHttpError` — a different server, a different envelope
 * (`{ error, message }` + `retry-after`) and a different set of things that can
 * go wrong. What they DO share with the rest of this package is the contract:
 * an expected failure is a discriminated object with a `code`, never a throw
 * and never a string dump.
 *
 * THE RULE THAT MAKES THESE USEFUL: every failure names the NEXT MOVE, and for
 * an agent the next move is a TOOL, not a shell command. A CLI refusal can say
 * "run `hogsend signup`"; an agent holding these tools needs to be told
 * `cloud_signup`. So the CLI's rendered refusal supplies the sentence and this
 * module supplies the code and the tool name — the two are not the same
 * audience and pretending otherwise is how an agent ends up shelling out.
 */

/** Every expected failure the cloud tools surface. */
export type CloudFailureCode =
  /** No stored session (or it was revoked). Fixed by `cloud_signup`. */
  | "needs_auth"
  /** A real credential, insufficient role. Fixed by a human, not a tool. */
  | "forbidden"
  /** No such build/environment, or not visible to this session. */
  | "not_found"
  /** The cloud asked us to slow down; `retryAfterSeconds` says how long. */
  | "rate_limited"
  /** The OTP was wrong, expired, or burned through its attempt budget. */
  | "invalid_code"
  /** The engine version disagrees with the stack's. */
  | "engine_version_mismatch"
  /** `--env <name>` named nothing, or the org has no production environment. */
  | "no_environment"
  /** The given cwd is not inside a Hogsend scaffold. */
  | "not_a_scaffold"
  /** The tarball is over the cap, or unreadable. */
  | "invalid_tarball"
  /** Nothing reached the control plane at all. */
  | "unreachable"
  /** Anything the vocabulary above does not cover. */
  | "error";

export interface CloudFailure {
  ok: false;
  code: CloudFailureCode;
  /** One sentence, from the cloud where it wrote a good one. */
  error: string;
  /** What to do next, PHRASED FOR AN AGENT — a tool name, not a command. */
  hint?: string;
  /** HTTP status when there was one (0 for a transport failure). */
  status?: number;
  /** Seconds, from `retry-after`, when the cloud asked us to wait. */
  retryAfterSeconds?: number;
}

export function cloudFailure(
  code: CloudFailureCode,
  error: string,
  extra: { hint?: string; status?: number; retryAfterSeconds?: number } = {},
): CloudFailure {
  return {
    ok: false,
    code,
    error,
    ...(extra.hint === undefined ? {} : { hint: extra.hint }),
    ...(extra.status === undefined ? {} : { status: extra.status }),
    ...(extra.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: extra.retryAfterSeconds }),
  };
}

/** The one sentence every unauthenticated tool ends on. */
export const NEEDS_AUTH_HINT =
  "Call `cloud_signup` with an email, then `cloud_verify` with the code from that inbox.";

export function needsAuth(error: string): CloudFailure {
  return cloudFailure("needs_auth", error, { hint: NEEDS_AUTH_HINT });
}

/**
 * Map ANY error the shared cloud library can produce onto the vocabulary.
 *
 * Deliberately total over the library's error types rather than over HTTP
 * statuses alone: `NotLoggedInError` never reaches the network, `ScaffoldError`
 * is about the local disk, and both are far more common in an agent's first
 * minute than any status code. An error this does not recognise is re-thrown —
 * that is a bug, and the contract says bugs propagate.
 */
export function mapCloudError(
  error: unknown,
  ctx: { cloudHost: string; envName?: string },
): CloudFailure {
  // Local, pre-network failures first.
  if (error instanceof NotLoggedInError) {
    return needsAuth(error.message);
  }
  if (error instanceof ScaffoldError) {
    return cloudFailure("not_a_scaffold", error.message, {
      hint: "Point `cwd` at a directory inside an app scaffolded by create-hogsend.",
    });
  }
  if (error instanceof EmailLoginError) {
    if (error.verdict === "rate_limited") {
      return cloudFailure("rate_limited", error.message, {
        ...(error.hint === undefined ? {} : { hint: error.hint }),
        ...(error.retryAfter === undefined
          ? {}
          : { retryAfterSeconds: error.retryAfter }),
      });
    }
    if (
      error.verdict === "invalid_code" ||
      error.verdict === "code_expired" ||
      error.verdict === "code_burned"
    ) {
      return cloudFailure("invalid_code", error.message, {
        hint:
          error.verdict === "invalid_code"
            ? "Check the code in the inbox and call `cloud_verify` again."
            : "That code is dead — call `cloud_signup` for a fresh one.",
      });
    }
    return cloudFailure("error", error.message, {
      ...(error.hint === undefined ? {} : { hint: error.hint }),
    });
  }
  if (error instanceof PublishError) {
    const code: CloudFailureCode =
      error.verdict === "no_environment" ? "no_environment" : "error";
    return cloudFailure(code, error.message, {
      ...(error.hint === undefined ? {} : { hint: error.hint }),
    });
  }

  if (!isCloudError(error)) throw error;
  return mapCloudHttpError(error, ctx);
}

/** The control plane's HTTP refusals. */
function mapCloudHttpError(
  error: CloudError,
  ctx: { cloudHost: string; envName?: string },
): CloudFailure {
  // The CLI already writes a good sentence for each of these; what changes for
  // an agent is the HINT, which must name a tool rather than a command.
  const rendered = describeCloudRefusal(error, {
    cloudHost: ctx.cloudHost,
    ...(ctx.envName === undefined ? {} : { envName: ctx.envName }),
  });

  if (error.status === 0) {
    return cloudFailure("unreachable", rendered.headline, {
      hint: `Nothing reached ${ctx.cloudHost}. Check the URL (HOGSEND_CLOUD_URL) and the network.`,
      status: 0,
    });
  }
  if (error.status === 401) {
    return { ...needsAuth(rendered.headline), status: 401 };
  }
  if (error.status === 403) {
    return cloudFailure("forbidden", rendered.headline, {
      ...(rendered.hint === undefined ? {} : { hint: rendered.hint }),
      status: 403,
    });
  }
  if (error.status === 404) {
    return cloudFailure("not_found", rendered.headline, {
      ...(rendered.hint === undefined ? {} : { hint: rendered.hint }),
      status: 404,
    });
  }
  if (error.status === 409 && error.code === "engine_version_mismatch") {
    return cloudFailure("engine_version_mismatch", rendered.headline, {
      ...(rendered.hint === undefined ? {} : { hint: rendered.hint }),
      status: 409,
    });
  }
  if (error.status === 413) {
    return cloudFailure("invalid_tarball", rendered.headline, {
      ...(rendered.hint === undefined ? {} : { hint: rendered.hint }),
      status: 413,
    });
  }
  if (error.status === 429) {
    return cloudFailure("rate_limited", rendered.headline, {
      ...(rendered.hint === undefined ? {} : { hint: rendered.hint }),
      status: 429,
      ...(error.retryAfter === undefined
        ? {}
        : { retryAfterSeconds: error.retryAfter }),
    });
  }
  return cloudFailure("error", rendered.headline, {
    ...(rendered.hint === undefined ? {} : { hint: rendered.hint }),
    status: error.status,
  });
}
