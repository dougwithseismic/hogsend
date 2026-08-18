---
"@hogsend/engine": minor
"@hogsend/js": minor
"@hogsend/react": minor
"@hogsend/core": minor
---

Browser-readable contact traits. `createHogsendClient({ contacts: { publicProperties, exposeEmail } })` is an operator allowlist of exact `contacts.properties` keys (default `[]` / `false`, so an existing deploy exposes nothing), and `GET /v1/contacts/me` returns that projection for the recipient resolved server-side through the same identity boundary as `GET /v1/flags` and the in-app feed. A request-supplied contact key is never honored; no contact or an empty allowlist answers `200 { identified: false, traits: {} }` rather than `404`.

`@hogsend/js` gains a reactive `contact` slice with `hogsend.getContact()` / `hogsend.getTrait(key)`, refreshed on init, on identity change, and after `identify()` resolves, and cleared on `reset()`. `@hogsend/react` gains `useContact()` and `useTrait(key)`. `@hogsend/core` adds the zero-dependency `@hogsend/core/contact-traits` subpath with the augmentable `ContactTraitsMap` for typed keys and narrowed values.
