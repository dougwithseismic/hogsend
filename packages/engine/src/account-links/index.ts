// The two built-in account-link providers. Config over the `@hogsend/core`
// presets, NOT plugin packages (DECISIONS §3.1): a provider here is a URL, one
// `fetch` and a field mapping — zero dependencies, no runtime. Steam and
// Twitch are deliberately the ONLY first-party providers here (DECISIONS
// §12): a platform whose linking already ships elsewhere in this repo must
// keep its single writer, so it gets no second definition in this directory.
export { type SteamAccountLinkConfig, steamAccountLink } from "./steam.js";
export { type TwitchAccountLinkConfig, twitchAccountLink } from "./twitch.js";
