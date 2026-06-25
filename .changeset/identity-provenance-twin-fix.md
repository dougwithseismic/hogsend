---
"@hogsend/engine": patch
"@hogsend/db": patch
"@hogsend/core": patch
"@hogsend/cli": patch
"@hogsend/client": patch
"@hogsend/email": patch
"@hogsend/js": patch
"@hogsend/react": patch
"@hogsend/plugin-posthog": patch
"@hogsend/plugin-resend": patch
"@hogsend/plugin-postmark": patch
"@hogsend/plugin-discord": patch
"@hogsend/plugin-telegram": patch
"@hogsend/studio": patch
"hogsend": patch
"create-hogsend": patch
---

fix(engine): provenance-pin engine-internal re-ingests so a contact's own canonical key never mints a phantom identified twin

A server-side re-ingest keyed by `userId = <a contact's canonical key>` (which for an anonymous — or email+anon — contact IS its `anonymous_id`) was resolved through the value path, which only matches `external_id`, so it minted a second "identified" contact `{ external_id: <anonId> }`. That phantom twin then tripped the in-app feed's `collidesWithIdentified` guard, 403-ing the visitor out of their OWN feed (`anonymousId is not addressable`). The most direct trigger was the feed's own mark-read / mark-all re-ingests.

Fix: engine-internal re-emit sites now carry the subject's unforgeable contact row id (`contactId`) and the resolver pins to that exact row (`resolveByContactId`, `FOR UPDATE`, follows merge-aliases to the survivor) — never value-resolving, never minting. The public `/v1/events`/`/v1/feed` routes cannot supply `contactId` (schemas omit it, handlers build the resolve literally, and it's mutually exclusive with the publishable clamp), so the anti-impersonation boundary is unchanged and `collidesWithIdentified` stays strict. Threaded through `ingestEvent` + the feed mark/clear re-ingests; genuine external identities (no `contactId`) take the unchanged value path.
