---
"@hogsend/engine": minor
---

Identity columns demoted (PRD 07). The identity table is now the thing that RESOLVES a person; `contacts.external_id` / `contacts.anonymous_id` survive as written display mirrors, never dropped.

Security fix. The feed-read and arrival-stamp guards (`collidesWithIdentified`) and the claim gate (`keysAnotherContact`) now read `contact_aliases` in addition to the identity columns. The column probes are blind to a merged loser's stale keys (its row is soft-deleted), so before this release a publishable caller could present a merged-away external key as `anonymousId` to read that person's pre-merge feed items, or claim the stale key cross-kind and hijack its resolution. Both are closed. Deliberate tightening: an identified contact's email is no longer addressable as an anon id either.

Resolution reads flip onto the identity table. A stale (merged-away) key now resolves the SURVIVOR at: `/v1/contacts/find`, `DELETE /v1/contacts` (erasure by an old email erases the person it folded into), the admin contact detail and search, the admin bucket members filter, the secret-key feed recipient (email leg), the bucket accessor `has()`, bucket membership checks and reconcile re-confirms, refinement, timezone writes, connector member refs, and journey-run subject probes (which also stop missing anon-keyed subjects — an old bug). The engine's resolver primitives (`findByKey`, `lookupContactIdByKey`, `resolveViaAlias`) keep their column legs as the backstop for deployments whose alias backfill has not run; they and the guards are now the only code that touches the identity columns for lookup.

The last string-rewrite machinery is gone: a merge no longer rewrites the loser's `user_id` onto the survivor key. History rows keep the key they were written under forever; ownership moves on `contact_id` alone (the merge still dedupes against the contact-scoped unique indexes before re-parenting).

`contact_id` stays nullable on all five history tables, by design, permanently — each schema column now carries a comment naming its null-producing writer (the refusal path, raw-address sends, contactless enrollment/preferences), and behaviour tests pin that a contactless subject enrolls, runs, and keeps its opt-outs.

Not changed: both columns keep being written on create/fill-in/merge; `Contact.externalId` and every serialized shape; the `/v1/events` `contactKey` wire field; flag and holdout assignments (`contactKey()` derivation untouched). New read-only ops tool: `scripts/identity-census.sql` reports `contact_id` null counts and alias-vs-column parity — run it before trusting the flip on a large deployment.
