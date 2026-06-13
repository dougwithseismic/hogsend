import { parseArgs } from "node:util";
import { confirm, select, text } from "@clack/prompts";
import { openBrowser } from "../lib/browser.js";
import {
  ConnectError,
  type ConnectFlowDeps,
  runConnectPosthog,
} from "../lib/connect-flow.js";
import { startLoopbackServer } from "../lib/loopback.js";
import { discoverOAuthServer, exchangeCode } from "../lib/oauth.js";
import { color } from "../lib/output.js";
import { bail } from "../lib/prompt.js";
import type { Command, CommandContext } from "./types.js";

const usage = `hogsend connect <provider> [--posthog-host <url>] [--provision-only] [--no-provision] [--no-browser] [--json]

Connect this Hogsend instance to an analytics provider via OAuth. Providers:

  posthog    Authorize Hogsend against your PostHog region (PKCE, loopback
             callback on 127.0.0.1), store the refresh token on the instance,
             then provision the PostHog -> Hogsend event loop (a PostHog
             destination posting to /v1/webhooks/posthog).

The browser consent must happen on THIS machine (the OAuth callback lands on
127.0.0.1). The target instance can be anywhere — point --url at it and run
this command from your laptop, not from an SSH session on the server.

Options:
  --posthog-host     PostHog app/private host to authorize against, e.g.
                     https://eu.posthog.com or https://us.posthog.com (NOT the
                     i. ingestion host). Required when the instance has no
                     PostHog config and you're running non-interactively.
  --provision-only   Skip OAuth; (re-)provision the event loop using the
                     already-stored credential.
  --no-provision     Stop after storing the credential.
  --no-browser       Don't spawn a browser; just print the authorize URL.
  --url, --admin-key, --json, -h, --help   Global flags as usual.

Exit code: 0 when a credential is stored (even if provisioning was skipped),
1 otherwise.`;

async function run(ctx: CommandContext): Promise<void> {
  const { values, positionals } = parseArgs({
    args: ctx.argv,
    allowPositionals: true,
    strict: false,
    options: {
      "posthog-host": { type: "string" },
      "provision-only": { type: "boolean", default: false },
      "no-provision": { type: "boolean", default: false },
      "no-browser": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    ctx.out.log(usage);
    return;
  }

  const provider = positionals[0];
  if (!provider) {
    ctx.out.fail("missing provider — try: hogsend connect posthog");
  }
  if (provider !== "posthog") {
    ctx.out.fail(`unknown provider "${provider}" — supported: posthog`);
  }

  if (values["provision-only"] && values["no-provision"]) {
    ctx.out.fail("--provision-only and --no-provision are mutually exclusive");
  }

  // The PUT carries the OAuth tokens — warn when they'd ride plain http to a
  // non-local instance.
  try {
    const target = new URL(ctx.cfg.baseUrl);
    if (
      target.protocol === "http:" &&
      target.hostname !== "localhost" &&
      target.hostname !== "127.0.0.1"
    ) {
      ctx.out.log(
        color.yellow(
          `warning: ${ctx.cfg.baseUrl} is plain http — OAuth tokens will ` +
            "be sent to it unencrypted; use https for remote instances.",
        ),
      );
    }
  } catch {
    // unparseable base URL — the HTTP client will surface it
  }

  ctx.out.intro(`${color.bgMagenta(color.black(" hogsend "))} connect`);

  const deps: ConnectFlowDeps = {
    http: ctx.http,
    out: ctx.out,
    interactive: ctx.out.interactive,
    discover: discoverOAuthServer,
    startLoopback: startLoopbackServer,
    exchangeCode,
    openBrowser,
    confirm: async (message) => bail(await confirm({ message })),
    selectRegion: async () => {
      const choice = bail(
        await select({
          message: "Which PostHog region should Hogsend authorize against?",
          options: [
            { value: "https://eu.posthog.com", label: "PostHog EU Cloud" },
            { value: "https://us.posthog.com", label: "PostHog US Cloud" },
            { value: "custom", label: "Custom / self-hosted" },
          ],
        }),
      ) as string;
      if (choice !== "custom") return choice;
      return bail(
        await text({
          message:
            "PostHog app/private host URL (e.g. https://posthog.example.com)",
          placeholder: "https://posthog.example.com",
          validate: (value) => {
            try {
              const url = new URL(value ?? "");
              if (url.protocol !== "http:" && url.protocol !== "https:") {
                return "Enter a full URL, e.g. https://posthog.example.com";
              }
            } catch {
              return "Enter a full URL, e.g. https://posthog.example.com";
            }
          },
        }),
      );
    },
    now: () => new Date(),
  };

  try {
    const result = await runConnectPosthog(deps, {
      provisionOnly: Boolean(values["provision-only"]),
      noProvision: Boolean(values["no-provision"]),
      noBrowser: Boolean(values["no-browser"]),
      posthogHost:
        typeof values["posthog-host"] === "string"
          ? values["posthog-host"]
          : undefined,
    });

    if (ctx.json) {
      // One document; ConnectResult carries no token material by invariant.
      ctx.out.json({ ok: true, ...result });
      return;
    }
    ctx.out.outro(
      color.green(
        `connect: posthog ${
          result.verdict === "connected"
            ? "connected"
            : "connected (loop not provisioned)"
        }`,
      ),
    );
  } catch (error) {
    if (error instanceof ConnectError) {
      if (ctx.json) {
        ctx.out.json({
          ok: false,
          verdict: error.verdict,
          error: error.message,
          hint: error.hint,
        });
        process.exit(1);
      }
      ctx.out.note(
        error.hint ? `${error.message}\n\n${error.hint}` : error.message,
      );
      ctx.out.outro(color.red(`connect: ${error.verdict}`));
      process.exit(1);
    }
    throw error; // router renders unexpected errors
  }
}

export const connectCommand: Command = {
  name: "connect",
  summary: "Connect an analytics provider via OAuth (posthog)",
  usage,
  run,
};
