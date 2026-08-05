import type { CliOptions } from "./prompts.js";
import { binCmd } from "./prompts.js";

/**
 * The hosting copy, written ONCE.
 *
 * A scaffolded app can be run locally, handed to Hogsend Cloud, or self-hosted
 * — the same repo either way, which is exactly why the scaffolder asks no
 * cloud-vs-self-host question (PRD 13 T5). The only thing missing was that
 * nobody was TOLD Cloud exists, so this is copy, not flow.
 *
 * It lives in its own module because four surfaces say it (the interactive
 * outro, the non-interactive outro, the template README, and — in its
 * web-first form — the Cloud dashboard and welcome email), and four hand-typed
 * copies of a command is how a command goes stale. The two surfaces inside
 * THIS package share these strings; the control plane cannot import from a
 * published scaffolder, so it keeps its own copy in
 * `apps/cloud/src/lib/cloud-onboarding.ts`.
 */

/** `hogsend login && hogsend publish`, in the app's own package manager. */
export function cloudPublishCmd(pm: CliOptions["packageManager"]): string {
  return `${binCmd(pm, "hogsend login")} && ${binCmd(pm, "hogsend publish")}`;
}

/** The trailing note on the Cloud line. */
export const CLOUD_HINT_NOTE = "# host it on Hogsend Cloud — we run it for you";

/** The third path. The README is where self-hosting is actually documented. */
export const SELF_HOST_NOTE = '# or self-host it — README.md → "Hosting"';

/**
 * The commands that RESUME a cloud handoff that did not finish (PRD 17).
 *
 * They live here for the same reason `cloudPublishCmd` does — one place owns
 * every `hogsend` command string this package prints, so a renamed command
 * cannot leave a stale instruction behind in an outro. The scaffolder's own
 * source is asserted to contain no hand-typed ones.
 *
 * `signup` rather than `login`, matching what the driver actually ran: telling
 * somebody to resume with a different command than the one that failed is how
 * a retry hits a different code path than the attempt did.
 */
export function cloudResumeCmds(
  pm: CliOptions["packageManager"],
  input: { email: string; cloudUrl?: string },
): string[] {
  const host = input.cloudUrl ? ` --cloud ${input.cloudUrl}` : "";
  return [
    binCmd(pm, `hogsend signup --email ${input.email}${host}`),
    binCmd(pm, `hogsend publish${host}`),
  ];
}

/** What to do next once the app IS live. */
export function cloudNextCmds(pm: CliOptions["packageManager"]): string[] {
  return [binCmd(pm, "hogsend open"), binCmd(pm, "hogsend env pull")];
}

/** The trailing notes on the two success lines. */
export const CLOUD_OPEN_NOTE = "# your instance in the dashboard";
export const CLOUD_ENV_PULL_NOTE =
  "# pull the live API URL + key into .env for local work";

/** The line that introduces the resume block. Said once, printed twice. */
export const CLOUD_RESUME_INTRO =
  "Your app is complete and works locally. To finish the deploy:";
