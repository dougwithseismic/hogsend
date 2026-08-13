---
"@hogsend/engine": minor
---

Account link container wiring. `createHogsendClient` gains an `accountLinks: { providers, hooks, allowedOrigins }` option group, and the client exposes three new fields: `accountLinkProviders` (an `AccountLinkProviderRegistry` keyed by `meta.id`, last-writer-wins, consumer providers merged after env presets), `accountLinkHooks` (the consumer's `AccountLinkHooks`, held verbatim — invoked only by the callback route and the link store, never by the container), and `accountLinkAllowedOrigins` (the parsed origin allowlist). Additive: a deploy with no account linking boots unchanged and stays silent.

Unlike email/SMS/analytics there is no single active account-link provider — the player picks one per link and the routes resolve by the `:provider` path param — so there is no `ACCOUNT_LINK_PROVIDER` env and no "not registered" boot throw. A provider whose credentials are missing is ABSENT from the registry, never present-but-disabled.

`parseAllowedOrigins` (exported) parses the ONE allowlist governing both `returnTo` and the `postMessage` targetOrigin, from the `ACCOUNT_LINK_ALLOWED_ORIGINS` csv concatenated env-first with `accountLinks.allowedOrigins`. It FAILS LOUD: a path, a bare `*`, a wildcard host, or any entry whose `new URL(entry).origin` does not round-trip throws at boot naming the offending entry — an allowlist entry is a security control, and a silently dropped one is a link button that spins to a timeout while the link has committed server-side. Registered providers with an empty allowlist warn once at boot.

New env vars, all optional: `ACCOUNT_LINK_TWITCH_CLIENT_ID` / `ACCOUNT_LINK_TWITCH_CLIENT_SECRET` (the Twitch OAuth pair), `STEAM_WEB_API_KEY` (profile pull + playtime sync only — Steam login is OpenID 2.0 and registers without it), `ACCOUNT_LINK_ALLOWED_ORIGINS`, and `ACCOUNT_LINK_STATE_TTL_SECONDS` (default 900). The engine also re-exports the `@hogsend/core` provider contract (`defineAccountLink`, `AccountLinkProvider`, `AccountLinkHooks`, …) and the new `AccountLinkProviderRegistry`.
