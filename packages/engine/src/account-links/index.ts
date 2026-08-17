// The six built-in account-link providers. Config over the `@hogsend/core`
// presets, NOT plugin packages (DECISIONS §3.1): a provider here is a URL, one
// `fetch` and a field mapping — zero dependencies, no runtime. Discord is the
// only excluded platform: it already ships via `plugin-discord`, and a second
// writer on `contacts.discordId` would drift.

export {
  type BattlenetAccountLinkConfig,
  battlenetAccountLink,
} from "./battlenet.js";
export { type EpicAccountLinkConfig, epicAccountLink } from "./epic.js";
export { type RiotAccountLinkConfig, riotAccountLink } from "./riot.js";
export { type SteamAccountLinkConfig, steamAccountLink } from "./steam.js";
export { type TwitchAccountLinkConfig, twitchAccountLink } from "./twitch.js";
export { type XboxAccountLinkConfig, xboxAccountLink } from "./xbox.js";
