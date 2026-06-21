import { DISCORD_API_BASE } from "../constants.js";

/**
 * The slash commands the native `/link` → `/verify` identify loop needs.
 * `/link` carries no options (it opens a private modal that collects the
 * email); `/verify` takes the emailed code (STRING option type = 3).
 */
export const LINK_VERIFY_COMMANDS = [
  {
    name: "link",
    description: "Link your email to your Discord account",
  },
  {
    name: "verify",
    description: "Verify a code we emailed you (fallback)",
    options: [
      {
        name: "code",
        description: "The code from your email",
        type: 3,
        required: true,
      },
    ],
  },
] as const;

/**
 * Idempotently register `/link` + `/verify` GLOBALLY (a PUT replaces the full
 * command set), so they appear in EVERY guild the bot is in — the
 * one-bot-many-guilds story (a guild-scoped PUT would only register in a single
 * guild and silently break multi-guild). The inline gateway runtime calls this
 * once the socket is ready, eliminating the forgotten manual
 * `discord:register-commands` step; idempotent, so re-running on each lease
 * acquisition (and after a token rotation) is safe.
 *
 * Best-effort: a non-2xx logs the HTTP STATUS ONLY (never the bot token, which
 * Discord's error body can echo) and never throws — the socket is already up.
 */
export async function registerSlashCommands(args: {
  botToken: string;
  applicationId: string;
}): Promise<void> {
  try {
    const res = await fetch(
      `${DISCORD_API_BASE}/applications/${args.applicationId}/commands`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bot ${args.botToken}`,
        },
        body: JSON.stringify(LINK_VERIFY_COMMANDS),
      },
    );
    if (!res.ok) {
      console.error(
        `discord slash-command registration failed (${res.status})`,
      );
    } else {
      console.log("discord slash-commands registered (/link, /verify)");
    }
  } catch (err) {
    console.error(
      "discord slash-command registration error:",
      err instanceof Error ? err.message : String(err),
    );
  }
}
