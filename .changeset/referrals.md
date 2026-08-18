---
"@hogsend/core": minor
"@hogsend/db": minor
"@hogsend/engine": minor
"@hogsend/client": minor
"@hogsend/js": minor
"@hogsend/react": minor
"@hogsend/mcp": minor
"@hogsend/studio": minor
"@hogsend/cli": patch
---

Referrals: `defineReferral()` turns a shared link into a referrer -> referee edge the engine already owns. New `shared` link type (`links.owner_contact_id`, `links.referral_id`), `referral_touches` edge log (migrations 0073, 0074), lifecycle touch -> bind -> qualify -> convert with `before*` vetoes and `referral.*` events on the bus and the outbound catalog. Attribution model, window, depth and level weights are parameters of `GET /v1/referrals/report`, never program config. Adds `/v1/referrals/{touch,import,tree/:contactId,me}`, the `referrals` scope, `getReferralLink()`, `@hogsend/client` `referrals.*`, `@hogsend/js` `referral.link()`, `@hogsend/react` `useReferralLink()`, MCP `get_referral_report`/`get_referral_tree`, and observe-only Studio views. No payouts.
