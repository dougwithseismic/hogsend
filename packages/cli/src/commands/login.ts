import { hostname } from "node:os";
import { parseArgs } from "node:util";
import { openBrowser } from "../lib/browser.js";
import { openCloudSession, storeCloudLogin } from "../lib/cloud-session.js";
import { DeviceLoginError, runDeviceLogin } from "../lib/device-login.js";
import { color } from "../lib/output.js";
import { runEmailLoginCommand } from "./signup.js";
import type { Command, CommandContext } from "./types.js";

const usage = `hogsend login [options]

Sign this machine in to Hogsend Cloud.

Prints a short code and a URL, and opens your browser at the approval page
with the code prefilled — you only confirm and approve. The printed code and
URL always work on their own, so a machine with no browser (SSH, CI) completes
the same flow by hand.

With --email, no browser is involved at all: a six-digit code is mailed to that
address and typed back here. Use it on a headless box, or when you would rather
not leave the terminal. If the address has no account yet it gets one, exactly
as \`hogsend signup\` would.

The session is stored at ~/.hogsend/credentials.json (mode 0600, one entry per
cloud host) and is never printed. Revoke it with \`hogsend logout\`, or from
Settings → CLI sessions in the dashboard.

Options:
  --email <address>  Sign in by emailed code instead of the browser flow.
  --cloud <url>      Cloud host (default HOGSEND_CLOUD_URL, else https://cloud.hogsend.com).
  --label <name>     Name this session in the dashboard (default: this machine's hostname).
  --no-browser       Print the URL; never try to open a browser.
  --json             Emit a single JSON result. Implies --no-browser.
  -h, --help         Show this help.

Examples:
  hogsend login
  hogsend login --email me@acme.com
  hogsend login --cloud https://cloud.acme.internal
  hogsend login --label ci-runner --no-browser`;

const badge = `${color.bgMagenta(color.black(" hogsend "))} login`;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface DeviceLoginCommandValues {
  cloud?: string;
  label?: string;
  noBrowser?: boolean;
}

/**
 * The browser device flow, as a function rather than only a command.
 *
 * Extracted so `hogsend publish` can offer it INLINE (PRD 16) without a second
 * copy of the mint → print → poll → store sequence. A publish that logged you
 * in slightly differently from `hogsend login` would be the kind of difference
 * nobody notices until a session ends up unlabelled or unstored.
 */
export async function runDeviceLoginCommand(
  ctx: CommandContext,
  values: DeviceLoginCommandValues,
): Promise<void> {
  const { cloud, client } = openCloudSession(
    values.cloud === undefined ? {} : { cloud: values.cloud },
  );

  ctx.out.intro(badge);
  ctx.out.log(`${color.dim("cloud")} ${cloud.baseUrl}`);

  const label = values.label ?? hostname();

  let result: Awaited<ReturnType<typeof runDeviceLogin>>;
  try {
    result = await runDeviceLogin(
      {
        label,
        // A json run has nobody watching a browser window, and a spawned
        // browser would be a side effect an agent never asked for.
        noBrowser: values.noBrowser === true || ctx.json,
      },
      {
        client,
        openBrowser,
        // Human-only. In --json mode the code still has to reach somebody, so
        // it goes to stderr, keeping stdout a single JSON document.
        emit: (line) => {
          if (ctx.json) process.stderr.write(`${line}\n`);
          else ctx.out.log(line);
        },
        sleep,
        now: () => Date.now(),
      },
    );
  } catch (error) {
    if (error instanceof DeviceLoginError) {
      ctx.out.fail(
        error.hint ? `${error.message} ${error.hint}` : error.message,
      );
    }
    throw error;
  }

  // Stored BEFORE anything else can fail, then labelled — see
  // `storeCloudLogin`, which both login paths share so the ordering cannot
  // drift between them.
  const labels = await storeCloudLogin({
    cloud,
    token: result.token,
    ...(values.cloud === undefined ? {} : { cloudFlag: values.cloud }),
  });
  const userLabel = labels.user;
  const orgLabel = labels.organization;

  if (ctx.json) {
    ctx.out.json({
      loggedIn: true,
      cloud: cloud.baseUrl,
      host: cloud.host,
      sessionId: result.sessionId,
      organizationId: result.organizationId,
      user: userLabel ?? null,
      organization: orgLabel ?? null,
    });
    return;
  }

  const who = userLabel ? ` as ${userLabel}` : "";
  const org = orgLabel ? ` in ${orgLabel}` : "";
  ctx.out.log(`${color.green("✓")} Signed in to ${cloud.host}${who}${org}.`);
  ctx.out.outro("Run `hogsend publish` from your app to deploy it.");
}

async function run(ctx: CommandContext): Promise<void> {
  const { values } = parseArgs({
    args: ctx.argv,
    allowPositionals: true,
    options: {
      email: { type: "string" },
      cloud: { type: "string" },
      label: { type: "string" },
      "no-browser": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    ctx.out.log(usage);
    return;
  }

  // `--email` is a DIFFERENT flow, not a variation on this one: it never mints
  // a device code, never opens a browser and never polls. The device flow
  // stays the default.
  if (values.email !== undefined) {
    await runEmailLoginCommand(
      ctx,
      {
        email: values.email,
        ...(values.cloud === undefined ? {} : { cloud: values.cloud }),
      },
      { verb: "login", badge },
    );
    return;
  }

  await runDeviceLoginCommand(ctx, {
    ...(values.cloud === undefined ? {} : { cloud: values.cloud }),
    ...(values.label === undefined ? {} : { label: values.label }),
    noBrowser: values["no-browser"] === true,
  });
}

export const loginCommand: Command = {
  name: "login",
  summary: "Sign this machine in to Hogsend Cloud (device flow)",
  usage,
  run,
};
