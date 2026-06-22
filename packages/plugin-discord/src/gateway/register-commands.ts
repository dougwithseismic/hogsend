import { DISCORD_API_BASE } from "../constants.js";

/**
 * The slash command the cold-connect link-confirm flow needs. `/link` carries no
 * options — it opens a private modal that collects the email, then emails a
 * one-click confirm LINK (there is no typed-code `/verify` step anymore).
 */
export const LINK_COMMANDS = [
  {
    name: "link",
    description: "Link your email to your Discord account",
  },
] as const;

/**
 * Idempotently register `/link` GLOBALLY (a PUT replaces the full command set),
 * so it appears in EVERY guild the bot is in — the one-bot-many-guilds story (a
 * guild-scoped PUT would only register in a single guild and silently break
 * multi-guild). The inline gateway runtime calls this once the socket is ready,
 * eliminating the forgotten manual `discord:register-commands` step; idempotent,
 * so re-running on each lease acquisition (and after a token rotation) is safe.
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
        body: JSON.stringify(LINK_COMMANDS),
      },
    );
    if (!res.ok) {
      console.error(
        `discord slash-command registration failed (${res.status})`,
      );
    } else {
      console.log("discord slash-command registered (/link)");
    }
  } catch (err) {
    console.error(
      "discord slash-command registration error:",
      err instanceof Error ? err.message : String(err),
    );
  }
}
