import { parseArgs } from "node:util";
import { confirm, password, select, text } from "@clack/prompts";
import { openBrowser } from "../lib/browser.js";
import {
  ConnectDiscordError,
  type ConnectDiscordFlowDeps,
  type DiscordSecrets,
  runConnectDiscord,
} from "../lib/connect-discord-flow.js";
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

const usage = `hogsend connect <provider> [options] [--no-browser] [--json]

Connect this Hogsend instance to a provider. Providers:

  posthog    Authorize Hogsend against your PostHog region (PKCE, loopback
             callback on 127.0.0.1), store the refresh token on the instance,
             then provision the PostHog -> Hogsend event loop (a PostHog
             destination posting to /v1/webhooks/posthog).

  discord    One-time Discord developer-portal setup: paste the four portal
             values (application id, public key, bot token, client secret),
             store them on the instance, wire the interactions endpoint
             (PATCH /applications/@me) server-side, then open the one-click
             bot-install link and capture the guild id.

For posthog, the browser consent must happen on THIS machine (the OAuth
callback lands on 127.0.0.1). The target instance can be anywhere — point --url
at it and run this command from your laptop, not from an SSH session.

posthog options:
  --posthog-host     PostHog app/private host to authorize against, e.g.
                     https://eu.posthog.com or https://us.posthog.com (NOT the
                     i. ingestion host). Required when the instance has no
                     PostHog config and you're running non-interactively.
  --provision-only   Skip OAuth; (re-)provision the event loop using the
                     already-stored credential.
  --no-provision     Stop after storing the credential.

discord options:
  --status           Read-only: report what's stored/wired and the captured
                     guild id. Never prompts or stores anything.

Shared options:
  --no-browser       Don't spawn a browser; just print the URL(s).
  --url, --admin-key, --json, -h, --help   Global flags as usual.

Exit code: 0 when the connection is stored (even if a follow-up step was
skipped), 1 otherwise.`;

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
      status: { type: "boolean", default: false },
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
  if (provider === "discord") {
    await runDiscord(ctx, {
      noBrowser: Boolean(values["no-browser"]),
      statusOnly: Boolean(values.status),
    });
    return;
  }
  if (provider !== "posthog") {
    ctx.out.fail(
      `unknown provider "${provider}" — supported: posthog, discord`,
    );
  }

  if (values["provision-only"] && values["no-provision"]) {
    ctx.out.fail("--provision-only and --no-provision are mutually exclusive");
  }

  // The PUT carries the OAuth tokens — warn when they'd ride plain http to a
  // non-local instance.
  if (isPlainHttpRemote(ctx.cfg.baseUrl)) {
    ctx.out.log(
      color.yellow(
        `warning: ${ctx.cfg.baseUrl} is plain http — OAuth tokens will ` +
          "be sent to it unencrypted; use https for remote instances.",
      ),
    );
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

/** True when the base URL is plain http to a non-loopback host. */
function isPlainHttpRemote(baseUrl: string): boolean {
  try {
    const target = new URL(baseUrl);
    return (
      target.protocol === "http:" &&
      target.hostname !== "localhost" &&
      target.hostname !== "127.0.0.1"
    );
  } catch {
    // unparseable base URL — the HTTP client will surface it
    return false;
  }
}

/**
 * The `discord` branch: a one-time portal paste, server-side wiring, and the
 * one-click bot-install link. Mirrors the posthog branch's deps/error
 * handling; the testable orchestration lives in connect-discord-flow.ts.
 */
async function runDiscord(
  ctx: CommandContext,
  opts: { noBrowser: boolean; statusOnly: boolean },
): Promise<void> {
  // The PUT carries the bot token + client secret — REFUSE plain http to a
  // non-loopback instance (a secret must never ride unencrypted over the wire).
  // --status never PUTs, so it's exempt.
  if (!opts.statusOnly && isPlainHttpRemote(ctx.cfg.baseUrl)) {
    ctx.out.fail(
      `${ctx.cfg.baseUrl} is plain http — refusing to send the Discord bot ` +
        "token + client secret to a remote instance unencrypted. Use https, " +
        "or run --status (which sends no secrets).",
    );
  }

  ctx.out.intro(`${color.bgMagenta(color.black(" hogsend "))} connect`);

  const deps: ConnectDiscordFlowDeps = {
    http: ctx.http,
    out: ctx.out,
    interactive: ctx.out.interactive,
    confirm: async (message) => bail(await confirm({ message })),
    openBrowser,
    promptSecrets: async (): Promise<DiscordSecrets> => {
      const appId = bail(
        await text({
          message: "Discord Application ID (OAuth2 -> Client ID)",
          placeholder: "1234567890123456789",
        }),
      ) as string;
      const publicKey = bail(
        await text({
          message: "Public Key (General Information -> Public Key)",
          placeholder: "abc123...",
        }),
      ) as string;
      const botToken = bail(
        await password({ message: "Bot Token (Bot -> Reset Token)" }),
      ) as string;
      const clientSecret = bail(
        await password({
          message: "Client Secret (OAuth2 -> Client Secret)",
        }),
      ) as string;
      return { appId, publicKey, botToken, clientSecret };
    },
    now: () => new Date(),
  };

  try {
    const result = await runConnectDiscord(deps, {
      noBrowser: opts.noBrowser,
      statusOnly: opts.statusOnly,
    });

    if (ctx.json) {
      // One document; ConnectDiscordResult carries no secret material.
      ctx.out.json({ ok: true, ...result });
      return;
    }
    ctx.out.outro(
      color.green(
        `connect: discord ${
          result.verdict === "connected"
            ? "connected"
            : "secrets stored (interactions not wired)"
        }`,
      ),
    );
  } catch (error) {
    if (error instanceof ConnectDiscordError) {
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
  summary: "Connect a provider (posthog OAuth, discord bot)",
  usage,
  run,
};
