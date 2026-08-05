import { select } from "@clack/prompts";
import { runDeviceLoginCommand } from "../commands/login.js";
import { runEmailLoginCommand } from "../commands/signup.js";
import type { CommandContext } from "../commands/types.js";
import { isCloudError } from "./cloud-http.js";
import { cloudSuffix } from "./cloud-refusals.js";
import type { CloudSession, CloudSessionOptions } from "./cloud-session.js";
import { NotLoggedInError, requireCloudSession } from "./cloud-session.js";
import { bail } from "./prompt.js";

/**
 * "You are not signed in" as an OFFER rather than an error (PRD 16).
 *
 * The scaffold's outro prints `hogsend login && hogsend publish`, which is two
 * commands for one intention. This module collapses them: a publish that finds
 * no session asks how you would like to sign in, does it, and carries on with
 * the SAME invocation — no re-run, no lost tarball, no re-typing the flags.
 *
 * THE RULE THAT SHAPES EVERYTHING HERE: a non-interactive run NEVER prompts.
 * Not "prompts with a default", not "prompts with a timeout" — never. A CI job
 * or an agent that hit a hidden prompt would block until its own timeout killed
 * it, with no output explaining why, which is strictly worse than failing in a
 * second. So every would-be prompt becomes a distinct nonzero exit naming the
 * exact command to run first.
 *
 * Both offered flows are the REAL commands (`runEmailLoginCommand`,
 * `runDeviceLoginCommand`), not reimplementations: a session minted inline must
 * be indistinguishable from one minted by `hogsend login`, down to the stored
 * labels and the write ordering.
 */

/** How a caller may sign in from inside another command. */
export type InlineAuthMethod = "email" | "browser";

export interface InlineAuthDeps {
  /**
   * Which method to use. Injected so a test can choose without a TTY; the
   * default asks with clack, and is only ever reached when `out.interactive`.
   */
  chooseMethod?(): Promise<InlineAuthMethod>;
  /** Overridable so a test can prove the choice is honoured without auth. */
  runEmail?(): Promise<void>;
  runDevice?(): Promise<void>;
}

export interface EnsureSessionOptions extends CloudSessionOptions {
  /** `--cloud <url>` exactly as the command parsed it, for the re-open. */
  cloudFlag?: string;
}

/**
 * What a HEADLESS caller is told to run.
 *
 * Email first here, unlike {@link signInHint}: the machines that hit this are
 * the ones with no terminal to prompt in, which are the same machines least
 * likely to have a browser. The second clause is the part only this surface
 * needs — a caller being turned away from a publish may have no account at
 * all, where somebody whose session merely expired certainly does.
 */
export function authRemedy(cloudFlag?: string): string {
  const suffix = cloudSuffix(cloudFlag);
  return [
    `Run \`hogsend login --email you@example.com${suffix}\` first`,
    `(or \`hogsend signup --email you@example.com${suffix}\` if you have no account yet).`,
  ].join(" ");
}

async function askMethod(): Promise<InlineAuthMethod> {
  return bail(
    await select({
      message: "You are not signed in. How would you like to?",
      options: [
        {
          value: "email" as const,
          label: "Email me a code",
          hint: "no browser needed",
        },
        {
          value: "browser" as const,
          label: "Open my browser",
          hint: "approve in the dashboard",
        },
      ],
    }),
  );
}

/**
 * Sign in from inside another command, or refuse.
 *
 * Returns when a session exists. Throws (via `out.fail`) when there is no way
 * to get one without asking a question nobody is there to answer.
 */
export async function runInlineAuth(
  ctx: CommandContext,
  options: EnsureSessionOptions = {},
  deps: InlineAuthDeps = {},
): Promise<void> {
  // The refusal, in the one place both callers reach it. `--json` counts as
  // non-interactive whatever the terminal is: a prompt would corrupt the single
  // JSON document even if somebody were watching.
  if (!ctx.out.interactive || ctx.json) {
    ctx.out.fail(`Not signed in. ${authRemedy(options.cloudFlag)}`);
  }

  const method = await (deps.chooseMethod ?? askMethod)();

  if (method === "email") {
    const runEmail =
      deps.runEmail ??
      (() =>
        runEmailLoginCommand(
          ctx,
          options.cloudFlag === undefined ? {} : { cloud: options.cloudFlag },
          // `login`, not `signup`: the wording is "welcome back" for the common
          // case, and the endpoint creates an account anyway if there is none,
          // so nobody is turned away.
          { verb: "login", badge: "" },
        ));
    await runEmail();
    return;
  }

  const runDevice =
    deps.runDevice ??
    (() =>
      runDeviceLoginCommand(
        ctx,
        options.cloudFlag === undefined ? {} : { cloud: options.cloudFlag },
      ));
  await runDevice();
}

/**
 * The session a command needs, signing in inline if there is not one.
 *
 * The re-read after authenticating is deliberate rather than reusing whatever
 * the flow returned: `requireCloudSession` is the one path that resolves the
 * host, reads the file and builds the bearer-bound client, so a session
 * obtained inline travels exactly the same route as one that was already there.
 */
export async function ensureCloudSession(
  ctx: CommandContext,
  options: EnsureSessionOptions = {},
  deps: InlineAuthDeps = {},
): Promise<
  CloudSession & { credential: NonNullable<CloudSession["credential"]> }
> {
  try {
    return requireCloudSession(options);
  } catch (error) {
    if (!(error instanceof NotLoggedInError)) throw error;
    await runInlineAuth(ctx, options, deps);
    // If this still refuses, the flow returned without storing anything, which
    // is a bug rather than a user-facing state — let it surface as one.
    return requireCloudSession(options);
  }
}

/**
 * Run `attempt`; if the cloud says 401, sign in and run it ONCE more.
 *
 * The case this exists for is a session revoked from the dashboard (or expired)
 * while a machine still holds the file — the credential looks fine locally and
 * fails at the first call. Retrying exactly once is the point: a second 401
 * after a fresh login is not a stale credential, it is something else, and
 * looping on it would hide that.
 *
 * `rebind` hands back whatever the caller needs re-derived from the NEW
 * credential (a client, a whole session), because the old one is bound to a
 * token the cloud has stopped accepting.
 */
export async function withReauth<T>(
  ctx: CommandContext,
  attempt: () => Promise<T>,
  rebind: () => void,
  options: EnsureSessionOptions = {},
  deps: InlineAuthDeps = {},
): Promise<T> {
  try {
    return await attempt();
  } catch (error) {
    if (!isCloudError(error) || error.status !== 401) throw error;

    if (!ctx.out.interactive || ctx.json) {
      ctx.out.fail(
        `That session is no longer valid — it was revoked or it expired. ${authRemedy(options.cloudFlag)}`,
      );
    }
    ctx.out.log("That session is no longer valid; signing you in again.");

    await runInlineAuth(ctx, options, deps);
    rebind();
    return attempt();
  }
}
