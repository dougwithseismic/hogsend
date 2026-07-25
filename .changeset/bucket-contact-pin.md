---
"@hogsend/engine": minor
---

Bucket transitions no longer mint phantom contacts for anonymous-only visitors.

`emitBucketTransition` re-ingested every transition with `userId` and no
`contactId` provenance pin. For a contact whose canonical key is its
`anonymous_id`, `resolveOrCreateContact` treats that key as an EXTERNAL one — it
probes `external_id`, `external`-kind aliases and a uuid-shaped fallback against
`contacts.id`, but never `anonymous_id` — so every probe missed and the create
arm inserted a duplicate row with `external_id` set to the anonymous id.

A browser visitor tracked with a publishable key and never identified is the
ordinary shape here, so this affected every bucket on every enter and leave, not
one feature. Contacts carrying an email were spared the twin but had a synthetic
`external_id` stamped onto the real row as a side effect of the transition.

The resolved contact id is now threaded through as an optional pin, into both
the per-bucket alias and generic re-ingests, at six of the seven call sites. The
fast-expiry timer deliberately does not pin: it wakes with only its Hatchet
payload, which is reachable from public ingest, and pinning to a caller-supplied
row id would be worse than not pinning.

Identity resolution itself is unchanged — `resolveOrCreateContact` still does not
probe `anonymous_id` for a bare `userId`, because that would alter every public
ingest path rather than the one code path with the bug.

Fixes #608.
