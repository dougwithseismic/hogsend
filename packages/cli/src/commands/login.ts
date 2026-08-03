import { hostname } from "node:os";
import { parseArgs } from "node:util";
import { openBrowser } from "../lib/browser.js";
import { openCloudSession } from "../lib/cloud-session.js";
import { writeCloudCredential } from "../lib/credentials.js";
import { DeviceLoginError, runDeviceLogin } from "../lib/device-login.js";
import { color } from "../lib/output.js";
import type { Command, CommandContext } from "./types.js";

const usage = `hogsend login [options]

Sign this machine in to Hogsend Cloud.

Prints a short code and a URL, and opens your browser at the approval page
with the code prefilled — you only confirm and approve. The printed code and
URL always work on their own, so a machine with no browser (SSH, CI) completes
the same flow by hand.

The session is stored at ~/.hogsend/credentials.json (mode 0600, one entry per
cloud host) and is never printed. Revoke it with \`hogsend logout\`, or from
Settings → CLI sessions in the dashboard.

Options:
  --cloud <url>      Cloud host (default HOGSEND_CLOUD_URL, else https://cloud.hogsend.com).
  --label <name>     Name this session in the dashboard (default: this machine's hostname).
  --no-browser       Print the URL; never try to open a browser.
  --json             Emit a single JSON result. Implies --no-browser.
  -h, --help         Show this help.

Examples:
  hogsend login
  hogsend login --cloud https://cloud.acme.internal
  hogsend login --label ci-runner --no-browser`;

const badge = `${color.bgMagenta(color.black(" hogsend "))} login`;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function run(ctx: CommandContext): Promise<void> {
  const { values } = parseArgs({
    args: ctx.argv,
    allowPositionals: true,
    options: {
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
        noBrowser: values["no-browser"] === true || ctx.json,
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

  // Stored BEFORE anything else can fail: a token that was approved but not
  // written would leave the human with no session and no way to know why.
  writeCloudCredential(cloud.host, {
    token: result.token,
    createdAt: new Date().toISOString(),
  });

  // Now that there IS a credential, resolve who it belongs to and record the
  // labels, so `whoami` reads offline and the file is self-describing.
  let userLabel: string | undefined;
  let orgLabel: string | undefined;
  try {
    const session = openCloudSession(
      values.cloud === undefined ? {} : { cloud: values.cloud },
    );
    const who = await session.client.get<{
      user: { email: string };
      organization: { name: string };
    }>("/api/cli/session");
    userLabel = who.user.email;
    orgLabel = who.organization.name;
    writeCloudCredential(cloud.host, {
      token: result.token,
      userLabel,
      orgLabel,
      createdAt: new Date().toISOString(),
    });
  } catch {
    // A cloud that cannot answer whoami right now has still issued a valid
    // session. The labels are a convenience, not the credential.
  }

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

export const loginCommand: Command = {
  name: "login",
  summary: "Sign this machine in to Hogsend Cloud (device flow)",
  usage,
  run,
};
