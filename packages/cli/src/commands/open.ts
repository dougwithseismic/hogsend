import { parseArgs } from "node:util";
import { openBrowser } from "../lib/browser.js";
import { isCloudError } from "../lib/cloud-http.js";
import { describeCloudRefusal, formatRefusal } from "../lib/cloud-refusals.js";
import {
  NotLoggedInError,
  openCloudSession,
  requireCloudSession,
} from "../lib/cloud-session.js";
import { color } from "../lib/output.js";
import {
  type EnvironmentListResponse,
  PublishError,
  selectEnvironment,
} from "../lib/publish-flow.js";
import type { Command, CommandContext } from "./types.js";

const usage = `hogsend open [options]

Open the Hogsend Cloud dashboard for this machine's session.

With no flags this opens the environment list for your organization. With
--env <name> it resolves that environment through the cloud and opens its page
directly — which needs a session, since environment names are tenant-scoped.

The URL is always PRINTED, whether or not a browser could be opened, so this
works over SSH and in CI.

Options:
  --env <name>       Open this environment's page (default: the org's environments).
  --cloud <url>      Cloud host (default HOGSEND_CLOUD_URL, else https://cloud.hogsend.com).
  --no-browser       Print the URL; never try to open a browser.
  --json             Emit a single JSON result. Implies --no-browser.
  -h, --help         Show this help.

Examples:
  hogsend open
  hogsend open --env staging`;

async function run(ctx: CommandContext): Promise<void> {
  const { values } = parseArgs({
    args: ctx.argv,
    allowPositionals: true,
    options: {
      env: { type: "string" },
      cloud: { type: "string" },
      "no-browser": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    ctx.out.log(usage);
    return;
  }

  const cloudOpts = values.cloud === undefined ? {} : { cloud: values.cloud };

  let url: string;
  let environmentName: string | undefined;

  if (values.env === undefined) {
    // No lookup needed — the list page resolves the caller's active org from
    // their dashboard session, which is the org they will want anyway.
    url = `${openCloudSession(cloudOpts).cloud.baseUrl}/environments`;
  } else {
    let session: ReturnType<typeof requireCloudSession>;
    try {
      session = requireCloudSession(cloudOpts);
    } catch (error) {
      if (error instanceof NotLoggedInError) {
        ctx.out.fail(
          `${error.message} ${error.hint} (\`--env\` resolves a name through the cloud, so it needs a session.)`,
        );
      }
      throw error;
    }

    try {
      const listed = await session.client.get<EnvironmentListResponse>(
        "/api/cli/environments",
      );
      const environment = selectEnvironment(listed.environments, values.env);
      environmentName = environment.name;
      url = `${session.cloud.baseUrl}/environments/${environment.id}`;
    } catch (error) {
      if (error instanceof PublishError) {
        ctx.out.fail(
          error.hint ? `${error.message} ${error.hint}` : error.message,
        );
      }
      if (isCloudError(error)) {
        ctx.out.fail(
          formatRefusal(
            describeCloudRefusal(error, {
              cloudHost: session.cloud.host,
              cloudExplicit: session.cloud.explicit,
            }),
          ),
        );
      }
      throw error;
    }
  }

  const skipBrowser = values["no-browser"] === true || ctx.json;
  const opened = skipBrowser ? false : openBrowser(url);

  if (ctx.json) {
    ctx.out.json({
      url,
      opened,
      ...(environmentName === undefined
        ? {}
        : { environment: environmentName }),
    });
    return;
  }

  ctx.out.log(url);
  if (!skipBrowser && !opened) {
    ctx.out.log(color.dim("(couldn't open your browser — open the URL above)"));
  }
}

export const openCommand: Command = {
  name: "open",
  summary: "Open the Hogsend Cloud dashboard (optionally an environment)",
  usage,
  run,
};
