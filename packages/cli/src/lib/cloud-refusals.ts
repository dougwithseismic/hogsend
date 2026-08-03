import type { CloudError } from "./cloud-http.js";

/**
 * Every way the control plane can say no, turned into something a human at a
 * terminal can act on.
 *
 * It is one module because the refusals are ONE vocabulary shared by the
 * intake, the status endpoint and the session endpoints — and because the
 * failure this prevents is a specific one: a CLI that prints the server's
 * message verbatim and leaves the operator to guess which flag, which command
 * or which person unblocks them. Every branch below ends in an instruction.
 *
 * The server's own `message` is kept as the headline wherever it is already the
 * right sentence (the cloud writes good ones), and the HINT is what this file
 * adds: the exact next move.
 */

export interface RefusalContext {
  /** The credentials-file key, for a `hogsend login --cloud <host>` hint. */
  cloudHost: string;
  /** Whether `--cloud` was explicit, so the hint only repeats it when useful. */
  cloudExplicit?: boolean;
  /** The environment name being published to, when there is one. */
  envName?: string;
}

export interface RenderedRefusal {
  headline: string;
  hint?: string;
}

function loginHint(ctx: RefusalContext): string {
  return ctx.cloudExplicit
    ? `Run \`hogsend login --cloud ${ctx.cloudHost}\`.`
    : "Run `hogsend login`.";
}

/** Read a field the cloud sent alongside its message. */
function field(body: unknown, key: string): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

export function describeCloudRefusal(
  error: CloudError,
  ctx: RefusalContext,
): RenderedRefusal {
  // Transport, not refusal: nothing reached the cloud at all.
  if (error.status === 0) {
    return {
      headline: error.message,
      hint: "Check the URL and your network, then try again.",
    };
  }

  if (error.status === 401) {
    return {
      headline: `Not signed in to ${ctx.cloudHost} (or the session was revoked).`,
      hint: loginHint(ctx),
    };
  }

  if (error.status === 403) {
    if (error.code === "forbidden_role") {
      return {
        headline: error.message,
        hint: "Ask an owner or admin of this organization to grant you the developer role.",
      };
    }
    if (error.code === "forbidden_role_credentials") {
      // Separate from `forbidden_role` because the remedy is a DIFFERENT role:
      // publishing needs developer, releasing a live credential needs owner or
      // admin, and pointing the caller at the wrong one wastes an ask.
      return {
        headline: error.message,
        hint: "Ask an owner or admin of this organization to run it, or to copy the values from the environment page.",
      };
    }
    if (error.code === "forbidden_organization") {
      return {
        headline: error.message,
        hint: loginHint(ctx),
      };
    }
    if (error.code === "forbidden_environment") {
      return {
        headline: error.message,
        hint: "Check which environment this token belongs to, or use a `hogsend login` session instead.",
      };
    }
    return { headline: error.message };
  }

  if (error.status === 404) {
    return {
      headline: error.message,
      hint: "That id does not exist, or this credential cannot see it.",
    };
  }

  if (error.status === 409 && error.code === "engine_version_mismatch") {
    const stackVersion = field(error.body, "stackVersion") ?? "unknown";
    const manifestVersion = field(error.body, "manifestVersion") ?? "unknown";
    const target = ctx.envName ? ` (${ctx.envName})` : "";
    return {
      headline: `Engine version mismatch${target}: the stack runs ${stackVersion}, this upload is built against ${manifestVersion}.`,
      hint: `If that change is intentional, re-run with --allow-upgrade. Otherwise align your @hogsend/engine dependency with ${stackVersion} and reinstall.`,
    };
  }

  if (error.status === 409 && error.code === "tenant_access_unavailable") {
    return {
      headline: error.message,
      hint: "Run `hogsend open --env <name>` to watch provisioning finish, then try again.",
    };
  }

  if (error.status === 413) {
    return {
      headline: error.message,
      hint: "Add the large paths to .gitignore — `node_modules`, `dist`, `.git` and `.env*` are already excluded.",
    };
  }

  if (error.status === 429) {
    const wait = error.retryAfter
      ? `Retry in about ${error.retryAfter}s.`
      : "Retry shortly.";
    return {
      headline: error.message,
      hint:
        error.code === "build_queue_full"
          ? `${wait} Each waiting publish holds a copy of your source on the build host, so the queue is bounded on purpose.`
          : wait,
    };
  }

  return { headline: error.message };
}

/** The refusal as one printable string. */
export function formatRefusal(rendered: RenderedRefusal): string {
  return rendered.hint
    ? `${rendered.headline}\n  ${rendered.hint}`
    : rendered.headline;
}
