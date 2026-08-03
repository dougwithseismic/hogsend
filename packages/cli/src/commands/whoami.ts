import { parseArgs } from "node:util";
import { isCloudError } from "../lib/cloud-http.js";
import { describeCloudRefusal, formatRefusal } from "../lib/cloud-refusals.js";
import { NotLoggedInError, requireCloudSession } from "../lib/cloud-session.js";
import { color } from "../lib/output.js";
import type { Command, CommandContext } from "./types.js";

const usage = `hogsend whoami [options]

Show which user and organization this machine's Hogsend Cloud session belongs
to. Asks the cloud rather than reading the local file, so a session that was
revoked from the dashboard reports as signed out — which is the question this
command is actually being asked.

Options:
  --cloud <url>      Cloud host (default HOGSEND_CLOUD_URL, else https://cloud.hogsend.com).
  --json             Emit a single JSON result.
  -h, --help         Show this help.`;

interface SessionResponse {
  session: {
    id: string;
    label: string | null;
    last4: string;
    createdAt: string;
    lastUsedAt: string | null;
  };
  user: { id: string; email: string; name: string };
  organization: { id: string; name: string; slug: string | null };
  role: string;
}

async function run(ctx: CommandContext): Promise<void> {
  const { values } = parseArgs({
    args: ctx.argv,
    allowPositionals: true,
    options: {
      cloud: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    ctx.out.log(usage);
    return;
  }

  let session: ReturnType<typeof requireCloudSession>;
  try {
    session = requireCloudSession(
      values.cloud === undefined ? {} : { cloud: values.cloud },
    );
  } catch (error) {
    if (error instanceof NotLoggedInError) {
      ctx.out.fail(`${error.message} ${error.hint}`);
    }
    throw error;
  }

  let who: SessionResponse;
  try {
    who = await session.client.get<SessionResponse>("/api/cli/session");
  } catch (error) {
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

  if (ctx.json) {
    ctx.out.json({
      cloud: session.cloud.baseUrl,
      host: session.cloud.host,
      user: who.user,
      organization: who.organization,
      role: who.role,
      session: who.session,
    });
    return;
  }

  ctx.out.kv(
    {
      cloud: session.cloud.baseUrl,
      user: `${who.user.name} <${who.user.email}>`,
      organization: who.organization.name,
      role: who.role,
      session: who.session.label ?? "(unlabelled)",
      "last used": who.session.lastUsedAt ?? "never",
    },
    `${color.bold("Hogsend Cloud")}`,
  );
}

export const whoamiCommand: Command = {
  name: "whoami",
  summary: "Show the signed-in cloud user, org and session",
  usage,
  run,
};
