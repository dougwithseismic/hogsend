---
"@hogsend/engine": minor
---

Account link events reach the journey plane: `defineJourney({ trigger: { event: "account.linked" } })` now fires, as do `account.unlinked` and `account.link_failed`. All event properties are scalars, but the three events carry DIFFERENT sets: `account.linked` has `state`/`provider`/`providerUserId`/`username`/`method`/`relink`/`version`, `account.unlinked` has `state`/`provider`/`providerUserId`/`reason`/`version`, and `account.link_failed` has only `provider`/`reason`. `version` stays a decimal string — compare it with `BigInt()`.

`POST /v1/accounts/import` does NOT enroll journeys unless you pass `enrollJourneys: true`, so a backfill cannot run a welcome journey once per imported row; the outbound webhook fires either way.

Also fixes a fail-open case in `collidesWithIdentified`: a contact keyed on its row uuid (neither `external_id` nor `anonymous_id` set) was invisible to the guard, so unauthenticated surfaces that accept an `anonymous_id` could file events under that person's canonical key.

This is a second plane beside the outbound webhook, not a replacement: the journey plane runs journeys inside Hogsend, the outbound spine ships state to your subscriber, and every link event reaches both. A failed link never creates a contact.
