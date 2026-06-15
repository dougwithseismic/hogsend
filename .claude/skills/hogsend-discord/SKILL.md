---
name: hogsend-discord
description: Operate the Hogsend community Discord (guild 1516090424194760744) with the discli CLI — create/edit channels, roles, permissions, post messages, manage the verification gate, and extend the /link flow. Use whenever building out or administering the Hogsend Discord server, adding channels/roles, changing permissions, posting announcements, or working on the gate / slash commands.
---

# Building the Hogsend Discord

The server is administered from the terminal with **discli** (`@ibbybuilds/discli`) — an agent-oriented Discord management CLI. This skill is the operational runbook + the gotchas that bit us building it.

## The setup (already done; here's the state)

- **Tool:** `npx -y @ibbybuilds/discli <cmd>` (no global install; it self-resolves).
- **Bot:** the existing **"Hogsend"** Discord application (app id `1515431439338967120`, bot user `Hogsend#2189`). Its token + secrets live in `apps/api/.env` (`DISCORD_BOT_TOKEN`, `DISCORD_APPLICATION_ID`, `DISCORD_PUBLIC_KEY`, `DISCORD_CLIENT_SECRET`). The SAME bot powers `@hogsend/plugin-discord` / the `/link` connector — see §`/link`.
- **discli config:** `~/.discli/.env` (key `BOT_TOKEN`). Set once via stdin so the token never echoes:
  ```bash
  grep '^DISCORD_BOT_TOKEN=' apps/api/.env | cut -d= -f2- | tr -d '\r\n' | npx -y @ibbybuilds/discli init
  ```
- **Target guild:** `1516090424194760744` ("Hogsend - Lifecycle Marketing For Scrappy Product Engineers").

## 🚨 Rule #1 — ALWAYS pass `--server`

`discli init` set the **default server to `withSeismic` (`1073262116619960421`)** — a DIFFERENT (dev) server. Every command MUST pin the community guild or you'll mutate the wrong server:

```bash
D="npx -y @ibbybuilds/discli --server 1516090424194760744"
$D channel list
$D role list
```

(You can repoint the default with `discli server select 1516090424194760744`, but `--server` on every call is the safe habit.)

## 🚨 Rate limits — pace writes ~4s apart, run in the background

Discord throttles rapid channel/role creates: a burst of ~10 then **HTTP 429**. discli does NOT auto-retry — it prints `Rate limited. Retry after Ns.` and moves on, **silently skipping that op**. So:

- Put multi-step buildouts in a script with `sleep 4` between calls, and run it **in the background** (the wait is long). See `scripts/provision-discord.sh`.
- After a paced run, **verify** (`channel list` / `role list` / `perm view`) — a skipped op leaves a gap. Re-apply any that 429'd.

## 🚨 Other gotchas (all hit while building)

- **`--type announcement` (news) needs Community Mode.** On a non-Community server it 400s (`Value must be one of {0,2,4,6,13,14,15,16}`). Use `text` and convert in-app later, or enable Community Mode in Server Settings first.
- **Role hierarchy is load-bearing.** A bot can only assign/manage roles **strictly below its own highest role**. New roles created via the API all land at **position 1 (tied)** — so the bot can't grant them until you reposition. We lifted the bot's managed `Hogsend` role to the TOP of the custom roles (`PATCH /guilds/{g}/roles` with explicit positions). If a role grant 403s, check hierarchy first.
- **Don't reset the bot token casually.** Resetting in the Developer Portal is **MFA-gated** (you can't do it headless) AND it invalidates the token the `apps/api` connector / dogfood share — breaking `/link`. Reuse the existing token.
- **Destructive ops need `--confirm`** (`channel delete`, `member kick/ban`, `msg delete`). Never add `--confirm` blindly on a destructive command.
- **`@everyone` in `perm set`** = the guild id (`1516090424194760744`), e.g. `perm set STAFF 1516090424194760744 --deny view_channel`.
- **Name collision → use the channel ID.** `msg send <name>` (and other name-resolving ops) can match a same-named **category** first — a `#events` text channel under an `EVENTS` category made `msg send events …` fail (you can't post to a category). When a channel shares a name with a category, target the channel by **id**.
- **Run buildout scripts via `bash`, not the zsh tool shell.** A `D="npx -y @ibbybuilds/discli --server …"` var does NOT word-split in zsh (you'll get `no such file or directory: npx -y …`). Use `bash /tmp/x.sh`, `bash -c '…'`, or a Python `subprocess.run([... ])` with an argv list.
- **Pace ~6s + retry on 429.** 4s isn't enough after a burst — the limiter prints `Rate limited. Retry after Ns` and **silently skips the op**. Wrap writes in a retry that parses `Retry after Ns`, waits `N+1`, and re-runs; always re-verify a phase (`channel list` / API GET) and re-apply gaps.
- **`server set --description` is Community-Mode-gated.** It no-ops on a non-Community server (the guild `description` field requires Community features) — set it from the UI after enabling Community Mode, alongside forum/announcement/stage channel types.

## discli command surface (what you'll use)

```bash
$D channel create "name"                       # text channel
$D channel create "name" --type voice|category # voice / category
$D channel create "name" --category HOGSEND --topic "…"
$D channel rename <id|name> "new"; $D channel move <id|name> --category X
$D channel delete <id|name> --confirm
$D role create "Name" --color "#eb459e" --hoist --mentionable
$D role create "Name" --permissions manage_channels,manage_roles,kick_members
$D role assign <role> <user>; $D role remove <role> <user>
$D perm set <channel> <role> --allow view_channel        # role names/ids; @everyone = guild id
$D perm set <channel> <role> --deny  view_channel,send_messages
$D perm view <channel>; $D perm list
$D msg send <channel> "text"; $D msg pin <channel> <msgId>; $D msg embed …
$D channel list; $D role list; $D server info; $D audit log
```

## The server structure (current) + the verification gate

Guests see **only `#link` + `#rules`**; the **`Community` role** unlocks everything. Running **`/link`** (verify email) grants `Community`.

Categories + key channels: **WELCOME** (`link`, `rules`, `start-here`, `announcements`, `resources`) · **COMMUNITY** (`general`, `introductions`, `showcase`, `lounge`🔊) · **HOGSEND** (`help`, `journeys`, `self-host`, `feedback`, `bug-reports`) · **DEV** (`changelog`, `ci-alerts`, `integrations`) · **STAFF** (Maintainer-only).

The gate permissions: `@everyone` is **denied `view_channel`** on WELCOME/COMMUNITY/HOGSEND/DEV; `#link` + `#rules` have an `@everyone` **allow** override; `Community` has **allow `view_channel`** on the gated categories. STAFF is Maintainer-only.

### Live IDs (target these directly)

| Roles | id | | Channels/cats | id |
|---|---|---|---|---|
| Hogsend (bot, managed) | `1516100587308191776` | | WELCOME (cat) | `1516101155128873042` |
| Maintainer | `1516101142822785165` | | #link | `1516123669225537667` |
| Contributor | `1516101147092586630` | | COMMUNITY (cat) | `1516101159239024711` |
| **Community** (verified) | `1516101150946889862` | | HOGSEND (cat) | `1516101163936645140` |
| @everyone | `1516090424194760744` (=guild) | | DEV (cat) | `1516101168546451557` |
| | | | STAFF (cat) | `1516101172333908008` |

## The `/link` feature (identity)

`/link` is a slash command → ephemeral email modal → emailed code → `/verify <code>` → links the member's email to their Discord (`discord_id` on the contact) AND grants the `Community` role (gate unlock). It's **HTTP-interactions** based: Discord POSTs to the bot's `interactions_endpoint_url` = `https://t.hogsend.com/v1/connectors/discord/interactions` (the dogfood deploy). Commands are registered per-guild via `apps/api/scripts/register-discord-commands.ts` (`DISCORD_GUILD_ID=1516090424194760744`). On a successful link the dogfood's `src/discord.ts` calls `client.identity.linkContact(...)`, which also emits the PostHog identity merge. If `/link` shows "interaction failed", the dogfood (t.hogsend.com) is down or the interactions endpoint is unset.

## Extending it

- **Re-run / repeatable buildout:** `scripts/provision-discord.sh` (paced, idempotent-ish). Edit the tree there and re-run.
- **Add a channel:** `$D channel create "name" --category HOGSEND --topic "…"` then `perm` if it should be gated/visible (it inherits its category's overwrites unless you set its own).
- **Add a role members can self-assign or that gates content:** create it, then `perm set <cat> <role> --allow view_channel`. If the bot must grant it, ensure the bot's `Hogsend` role is above it.
- **Post an announcement:** `$D msg send announcements "…"` (`#announcements` is plain text — Community Mode would make it a real announcement channel).

See also: the `project_hogsend-discord` memory for the durable facts, and `docs/posthog-identity-stitching.md` for how `/link` stitches PostHog identity.
