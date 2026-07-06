---
"@hogsend/js": patch
"@hogsend/react": patch
---

Consent-gated storage seam: `@hogsend/js` now exports its storage adapters
(`createMemoryStorage`, `createLocalStorage`) and `HogsendProvider` accepts a
`storage` prop forwarded to `createHogsend` — so a host app can keep the SDK
from persisting `hs_anon_id` until the visitor grants cookie/storage consent
(pass a memory or consent-gated adapter), matching the cookieless-until-consent
pattern already used for PostHog.
