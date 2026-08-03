import { parseArgs } from "node:util";
import { openCloudSession } from "../lib/cloud-session.js";
import { deleteCloudCredential } from "../lib/credentials.js";
import { color } from "../lib/output.js";
import type { Command, CommandContext } from "./types.js";

const usage = `hogsend logout [options]

Revoke this machine's Hogsend Cloud session and delete the local credential.

The revoke is attempted first so the token stops working everywhere, not just
here — but the local entry is deleted EITHER WAY. A cloud that is unreachable,
or a session already revoked from the dashboard, must never leave a token on
disk that the operator believes they removed.

Options:
  --cloud <url>      Cloud host (default HOGSEND_CLOUD_URL, else https://cloud.hogsend.com).
  --json             Emit a single JSON result.
  -h, --help         Show this help.`;

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

  const { cloud, credential, client } = openCloudSession(
    values.cloud === undefined ? {} : { cloud: values.cloud },
  );

  if (!credential) {
    if (ctx.json) {
      ctx.out.json({
        loggedOut: false,
        host: cloud.host,
        reason: "not_signed_in",
      });
      return;
    }
    ctx.out.log(`Not signed in to ${cloud.host}; nothing to do.`);
    return;
  }

  let revoked = false;
  let revokeError: string | undefined;
  try {
    await client.post("/api/cli/session/revoke");
    revoked = true;
  } catch (error) {
    // A 401 here means the session was ALREADY revoked (from the dashboard, or
    // by a previous logout). That is the state the caller asked for, so it is
    // not worth a scary message — but it is worth reporting in --json.
    revokeError = error instanceof Error ? error.message : String(error);
  }

  const removed = deleteCloudCredential(cloud.host);

  if (ctx.json) {
    ctx.out.json({
      loggedOut: true,
      host: cloud.host,
      serverRevoked: revoked,
      localRemoved: removed,
      ...(revokeError === undefined ? {} : { serverError: revokeError }),
    });
    return;
  }

  ctx.out.log(
    revoked
      ? `${color.green("✓")} Session revoked and removed from ${cloud.host}.`
      : `${color.green("✓")} Local credential for ${cloud.host} removed. ${color.dim(
          "(the cloud did not confirm a revoke — check Settings → CLI sessions)",
        )}`,
  );
}

export const logoutCommand: Command = {
  name: "logout",
  summary: "Revoke this machine's cloud session and delete the credential",
  usage,
  run,
};
