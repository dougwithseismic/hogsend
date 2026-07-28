---
"@hogsend/engine": patch
---

A managed-link click no longer mints a contact.

`pushLinkClickEvent` re-ingests the first-party `link.clicked` bus event keyed
on the link's `distinctId`. It did so with creation allowed, and `mintLink`
copies whatever `distinctId` the caller passes for a `personal` link — so a link
minted for a visitor who was never identified carried an anonymous key, and
clicking it wrote `external_id = <anonId>`.

That row is strictly worse than the ghost the previous release removed: it
answers `collidesWithIdentified`, which is what the publishable feed read and the
arrival stamp consult, so the visitor is then 403-locked out of their own feed.
The click re-ingest is a re-ingest derived from an earlier observation, and a
refusal is inherited by every derived re-ingest — the same law the feed marks,
`feed_cleared`, the journey holdout emit and the bucket transitions already
follow. This one path was missed.

Nothing is lost. The click still redirects, the `link.clicked` event still stores
under the same key, and journeys that trigger or `waitForEvent` on a link click
are unaffected — only the contact row is skipped. A link whose `distinctId` names
a contact that does exist resolves exactly as before.

Also corrects a comment on the `PUT /v1/contacts` request schema that claimed
identity was required. On the publishable path it is not: the route gates with
`gatePublishableIdentity`, which allows a caller who claims nothing, and the
create arm has no anonymous clamp — so a hand-rolled `pk_` request sending only
`anonymousId` still mints an anonymous-only contact. That behaviour is unchanged
and remains deliberately deferred (refusing needs a nullable `id` on a published
response schema); only the comment was wrong.
