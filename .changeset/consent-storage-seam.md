---
"@hogsend/js": patch
"@hogsend/react": patch
"@hogsend/cli": patch
"@hogsend/client": patch
"@hogsend/core": patch
"@hogsend/db": patch
"@hogsend/email": patch
"@hogsend/engine": patch
"@hogsend/plugin-discord": patch
"@hogsend/plugin-posthog": patch
"@hogsend/plugin-postmark": patch
"@hogsend/plugin-resend": patch
"@hogsend/plugin-telegram": patch
"@hogsend/studio": patch
"hogsend": patch
---

Consent-gated storage seam: `@hogsend/js` now exports its storage adapters
(`createMemoryStorage`, `createLocalStorage`) and `HogsendProvider` accepts a
`storage` prop forwarded to `createHogsend` — so a host app can keep the SDK
from persisting `hs_anon_id` until the visitor grants cookie/storage consent
(pass a memory or consent-gated adapter), matching the cookieless-until-consent
pattern already used for PostHog. Other engine-line packages ride along to
keep the version line uniform.
