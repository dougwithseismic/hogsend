import { hostname } from "node:os";
import { parseArgs } from "node:util";
import { text } from "@clack/prompts";
import { openCloudSession, storeCloudLogin } from "../lib/cloud-session.js";
import {
  DEFAULT_INTERACTIVE_ATTEMPTS,
  EmailLoginError,
  type EmailLoginResult,
  runEmailLogin,
} from "../lib/email-login.js";
import { color } from "../lib/output.js";
import { bail } from "../lib/prompt.js";
import { readLineFromStdin } from "../lib/read-line.js";
import type { Command, CommandContext } from "./types.js";

const usage = `hogsend signup [options]

Create a Hogsend Cloud account from this machine, or sign in to an existing one.

Asks for your email, mails you a six-digit code, and takes the code back. That
is the whole of it — there is no password. A brand-new address gets an account,
an organization and a production environment; an address that already has one
is simply signed in.

Nothing is provisioned until your first \`hogsend publish\`, so signing up costs
you nothing and takes seconds.

The session is stored at ~/.hogsend/credentials.json (mode 0600, one entry per
cloud host) and is never printed.

Options:
  --email <address>  Your email. Prompted for when this is a terminal.
  --org <name>       Name your organization. Ignored if you already have one.
  --cloud <url>      Cloud host (default HOGSEND_CLOUD_URL, else https://cloud.hogsend.com).
  --json             Emit a single JSON result. Reads the code from stdin.
  -h, --help         Show this help.

Examples:
  hogsend signup
  hogsend signup --email me@acme.com --org "Acme Rockets"
  echo 123456 | hogsend signup --email me@acme.com --json`;

const badge = `${color.bgMagenta(color.black(" hogsend "))} signup`;

/** The email shape the cloud will accept. Checked here to save a round trip. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface EmailLoginRunOptions {
  /** `hogsend login --email` reuses all of this; only the wording differs. */
  verb: "signup" | "login";
  badge: string;
}

export interface EmailLoginCommandDeps {
  /**
   * How a NON-INTERACTIVE run gets the code. Defaults to one line of stdin,
   * which is the real channel (`echo 123456 | hogsend signup --json`); a test
   * injects here so no suite ever blocks on a real stdin.
   */
  readLine?: () => Promise<string>;
}

/**
 * The shared body of `hogsend signup` and `hogsend login --email`.
 *
 * They are one function because the SERVER does not distinguish them: the same
 * two endpoints create an account that does not exist and sign in to one that
 * does, and which happened is reported back rather than chosen. Splitting them
 * would mean two places that have to agree about that.
 */
export async function runEmailLoginCommand(
  ctx: CommandContext,
  values: { email?: string; org?: string; cloud?: string },
  options: EmailLoginRunOptions,
  deps: EmailLoginCommandDeps = {},
): Promise<void> {
  const { cloud, client } = openCloudSession(
    values.cloud === undefined ? {} : { cloud: values.cloud },
  );

  // Human chrome to stderr in --json mode, exactly as `login` does: stdout
  // stays one JSON document, and the prompts still reach a human who is
  // watching.
  const emit = (line: string): void => {
    if (ctx.json) process.stderr.write(`${line}\n`);
    else ctx.out.log(line);
  };

  ctx.out.intro(options.badge);
  emit(`${color.dim("cloud")} ${cloud.baseUrl}`);

  const email = await resolveEmail(ctx, values.email, options.verb);
  const org = await resolveOrg(ctx, values.org, options.verb);

  let result: EmailLoginResult;
  try {
    result = await runEmailLogin(
      {
        email,
        label: hostname(),
        ...(org === undefined ? {} : { org }),
        // Only a terminal can be re-prompted; a piped run has one line of
        // stdin and re-reading it would block forever.
        maxAttempts: ctx.out.interactive ? DEFAULT_INTERACTIVE_ATTEMPTS : 1,
      },
      {
        client,
        emit,
        readCode: (attempt) => readCode(ctx, email, attempt, deps),
      },
    );
  } catch (error) {
    if (error instanceof EmailLoginError) {
      ctx.out.fail(
        error.hint ? `${error.message} ${error.hint}` : error.message,
      );
    }
    throw error;
  }

  // Stored BEFORE anything else can fail — see `storeCloudLogin`. The token
  // never reaches `emit`, `out.log` or the JSON payload.
  const labels = await storeCloudLogin({
    cloud,
    token: result.token,
    ...(values.cloud === undefined ? {} : { cloudFlag: values.cloud }),
  });

  if (ctx.json) {
    ctx.out.json({
      signedIn: true,
      cloud: cloud.baseUrl,
      host: cloud.host,
      created: result.created,
      sessionId: result.sessionId,
      userId: result.userId,
      organizationId: result.organizationId,
      environmentId: result.environmentId,
      note: result.note,
      user: labels.user ?? null,
      organization: labels.organization ?? null,
    });
    return;
  }

  // Honest about which of the two things happened, because they lead to
  // different next moves — and because "Welcome" to somebody who signed up
  // last week reads as a product that does not know them.
  const who = labels.user ? ` as ${labels.user}` : "";
  const where = labels.organization ? ` in ${labels.organization}` : "";
  ctx.out.log(
    result.created.user
      ? `${color.green("✓")} Welcome to Hogsend${who}${where}.`
      : `${color.green("✓")} Welcome back${who}${where}.`,
  );

  if (result.created.organization) {
    ctx.out.log(
      color.dim(
        "  Your instance is built on your first publish — nothing is running yet, and nothing is being billed.",
      ),
    );
  }
  if (result.note === "org_ignored_existing") {
    ctx.out.log(
      color.dim(
        "  You already have an organization, so --org was ignored. Run `hogsend open` to see it.",
      ),
    );
  }

  ctx.out.outro("Run `hogsend publish` from your app to deploy it.");
}

/** The address, from the flag or from a human. Never guessed. */
async function resolveEmail(
  ctx: CommandContext,
  flag: string | undefined,
  verb: "signup" | "login",
): Promise<string> {
  if (flag !== undefined) {
    const trimmed = flag.trim();
    if (!EMAIL_PATTERN.test(trimmed)) {
      ctx.out.fail(`"${trimmed}" is not an email address.`);
    }
    return trimmed.toLowerCase();
  }

  // No terminal and no flag: REFUSE, naming the exact flag. Prompting into a
  // pipe is how a CI job hangs for its whole timeout instead of failing in a
  // second with a message somebody can act on.
  if (!ctx.out.interactive) {
    ctx.out.fail(
      `No terminal to ask in. Pass the address: \`hogsend ${verb} --email you@example.com\`.`,
    );
  }

  const answer = bail(
    await text({
      message: "What is your email address?",
      placeholder: "you@example.com",
      validate: (value) =>
        EMAIL_PATTERN.test((value ?? "").trim())
          ? undefined
          : "Enter an email address.",
    }),
  );
  return answer.trim().toLowerCase();
}

/**
 * The organization name — OPTIONAL, and skippable.
 *
 * Only asked on signup, and only in a terminal. An empty answer is a real
 * answer: the cloud derives a name from the address, and being made to invent
 * a company name before you have deployed anything is the kind of question
 * that ends a signup.
 */
async function resolveOrg(
  ctx: CommandContext,
  flag: string | undefined,
  verb: "signup" | "login",
): Promise<string | undefined> {
  if (flag !== undefined) {
    const trimmed = flag.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (verb !== "signup" || !ctx.out.interactive) return undefined;

  const answer = bail(
    await text({
      message: "Name your organization (optional)",
      placeholder: "press enter to skip",
      defaultValue: "",
    }),
  );
  const trimmed = answer.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** The code: a clack prompt when there is a human, one line of stdin when not. */
async function readCode(
  ctx: CommandContext,
  email: string,
  attempt: number,
  deps: EmailLoginCommandDeps,
): Promise<string> {
  if (attempt === 0) {
    const line = `${color.green("✓")} We sent a code to ${email}. It is good for 10 minutes.`;
    if (ctx.json) process.stderr.write(`${line}\n`);
    else ctx.out.log(line);
  }

  if (!ctx.out.interactive) {
    return (await (deps.readLine ?? readLineFromStdin)()).trim();
  }

  return bail(
    await text({
      message: attempt === 0 ? "Paste the code" : "Try that code again",
      placeholder: "123456",
      validate: (value) =>
        (value ?? "").trim().length > 0 ? undefined : "Enter the code.",
    }),
  ).trim();
}

async function run(ctx: CommandContext): Promise<void> {
  const { values } = parseArgs({
    args: ctx.argv,
    allowPositionals: true,
    options: {
      email: { type: "string" },
      org: { type: "string" },
      cloud: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    ctx.out.log(usage);
    return;
  }

  await runEmailLoginCommand(
    ctx,
    {
      ...(values.email === undefined ? {} : { email: values.email }),
      ...(values.org === undefined ? {} : { org: values.org }),
      ...(values.cloud === undefined ? {} : { cloud: values.cloud }),
    },
    { verb: "signup", badge },
  );
}

export const signupCommand: Command = {
  name: "signup",
  summary: "Create a Hogsend Cloud account from this machine",
  usage,
  run,
};
