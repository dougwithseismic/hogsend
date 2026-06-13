/**
 * Register the Discord slash commands the native identify loop needs (`/link`
 * and `/verify`). Run with:
 *   pnpm --filter @hogsend/api discord:register-commands
 * (equivalently: tsx --env-file=.env scripts/register-discord-commands.ts).
 *
 * Set DISCORD_GUILD_ID for INSTANT guild-scoped registration (best for dev);
 * otherwise the commands register GLOBALLY (PUT replaces the full command set —
 * idempotent — but global propagation can take up to ~1h).
 *
 * SECRET HYGIENE: the bot token authenticates the request and is NEVER logged;
 * a non-2xx surfaces ONLY the HTTP status (Discord's error body can echo the
 * request). The slash-command STRING option type is 3.
 */
import { DISCORD_API_BASE } from "@hogsend/plugin-discord";

const appId = process.env.DISCORD_APPLICATION_ID;
const botToken = process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;
if (!appId || !botToken) {
  throw new Error("missing DISCORD_APPLICATION_ID or DISCORD_BOT_TOKEN in env");
}

const STRING_OPTION = 3;

const commands = [
  {
    name: "link",
    description: "Link your email to your Discord account",
    options: [
      {
        name: "email",
        description: "Your email address",
        type: STRING_OPTION,
        required: true,
      },
    ],
  },
  {
    name: "verify",
    description: "Verify the code we emailed you",
    options: [
      {
        name: "code",
        description: "The code from your email",
        type: STRING_OPTION,
        required: true,
      },
    ],
  },
];

const url = guildId
  ? `${DISCORD_API_BASE}/applications/${appId}/guilds/${guildId}/commands`
  : `${DISCORD_API_BASE}/applications/${appId}/commands`;

const res = await fetch(url, {
  method: "PUT",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bot ${botToken}`,
  },
  body: JSON.stringify(commands),
});
if (!res.ok) {
  throw new Error(`command registration failed (${res.status})`);
}
console.log(`registered /link + /verify (${guildId ? "guild" : "global"})`);
