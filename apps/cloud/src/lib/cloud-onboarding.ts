import { DEFAULT_CLOUD_PUBLIC_URL, env } from "../env";

/**
 * What we tell someone who signed up on the web BEFORE they had a repo.
 *
 * The scaffolder tells a person who already has a repo how to reach Cloud
 * (`packages/create-hogsend/src/cloud.ts`); this is the other direction, and
 * the non-obvious fact lives here: their instance is ALREADY running the
 * default scaffold image, so `publish` replaces what is there rather than
 * creating anything. Without that sentence people assume they have to start
 * over, or that the instance they are looking at is a placeholder.
 *
 * The commands are declared ONCE because two surfaces say them — the
 * environment page and the welcome email — and a stale command in a welcome
 * email is a support ticket. The scaffolder keeps its own copy on purpose: it
 * is a separately published package that cannot import from the control plane,
 * and its commands are package-manager aware.
 */
export const SCAFFOLD_COMMANDS = [
  "pnpm dlx create-hogsend my-app",
  "cd my-app",
  "pnpm hogsend login",
  "pnpm hogsend publish",
] as const;

/** The sentence that stops someone thinking they have to start over. */
export const PUBLISH_REPLACES_NOTE =
  "Your instance is already running the stock scaffold, so publish REPLACES what is there — it does not create a second one, and your Studio URL and API key do not change.";

/** The environment page. Built here for the same reason invitation URLs are:
 * Better Auth mints ids, the app owns routes. */
export function buildEnvironmentUrl(environmentId: string): string {
  const base = env.CLOUD_PUBLIC_URL ?? DEFAULT_CLOUD_PUBLIC_URL;
  return `${base.replace(/\/+$/, "")}/environments/${environmentId}`;
}

export interface WelcomeEmailFacts {
  organizationName: string;
  environmentName: string;
  environmentId: string;
}

export function welcomeEmailSubject(facts: WelcomeEmailFacts): string {
  return `Your Hogsend instance is running (${facts.organizationName}/${facts.environmentName})`;
}

/**
 * Plain text, same register as the OTP and invitation mails: facts about this
 * account, no marketing. Sent once, at `finish` — the first moment the claim
 * in the subject line is true.
 */
export function welcomeEmailBody(facts: WelcomeEmailFacts): string {
  return [
    `Your ${facts.environmentName} instance for ${facts.organizationName} is provisioned and running.`,
    "",
    `Open it: ${buildEnvironmentUrl(facts.environmentId)}`,
    "That page has your Studio link, its one-time password, and the .env snippet with your API key.",
    "",
    "No repo yet? A Hogsend app is a repo you own — these four commands make one and ship it here:",
    "",
    ...SCAFFOLD_COMMANDS.map((command) => `  ${command}`),
    "",
    PUBLISH_REPLACES_NOTE,
  ].join("\n");
}
