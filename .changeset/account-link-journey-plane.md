---
"@hogsend/engine": minor
---

Account link events reach the journey plane: `defineJourney({ trigger: { event: "account.linked" } })` now fires, as do `account.unlinked` and `account.link_failed`. Event properties are scalars (`provider`, `providerUserId`, `username`, `method`, `relink`, `version`, `state`), and `version` stays a decimal string — compare it with `BigInt()`.

This is a second plane beside the outbound webhook, not a replacement: the journey plane runs journeys inside Hogsend, the outbound spine ships state to your subscriber, and every link event reaches both. A failed link never creates a contact.
