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
