---
"@hogsend/engine": minor
---

Refinement now lands enrichment on the contact's canonical fields (`title`,
`seniority`, `company`, `company_domain`, `company_employees`, ...) instead of a
parallel `refined_*` namespace, and provenance moves into one nested
`enrichment: { provider, at }` object. Facts are written fill-if-absent, so a
paid vendor lookup never overwrites first-party data you already set; a
candidate-narrowing touch channel keeps fit buckets re-evaluating even when the
value was already present. The domain lookup precedence is reordered so the
enrichment ledger key stays replay-stable now that `company_domain` is both a
lookup input and a vendor output, and legacy `refined_*` ledger rows are
canonicalized on a cache hit.
