---
"@hogsend/engine": minor
---

Built-in account-link providers: `steamAccountLink` (OpenID 2.0, registered from env unconditionally — `STEAM_WEB_API_KEY` optionally adds the profile pull and playtime sync) and `twitchAccountLink` (OAuth2 + PKCE, registered when both `ACCOUNT_LINK_TWITCH_CLIENT_ID` and `ACCOUNT_LINK_TWITCH_CLIENT_SECRET` are set). Env presets merge into the container's account-link registry ahead of consumer-supplied providers.
