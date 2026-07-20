---
"@hogsend/db": minor
"@hogsend/engine": minor
"@hogsend/studio": patch
---

Policy-gated sends get a first-class `suppressed` status (new
`email_send_status` enum value, migration 0063). Suppression and test-mode
blocks used to write the same `failed` status as real dispatch failures —
and since a provider failure releases its idempotency key so a retry can
re-attempt, the two row shapes were byte-identical, which made the campaign
stats' `skipped`/`failed` split unsound (a provider failure would have been
reported as "suppressed" and `failed` could never fire in production).

Campaign stats and the Impact rollup now discriminate on status alone:
`skipped` = `suppressed` rows, `failed` = failed at dispatch, `sends` =
everything that was actually attempted. The always-zero per-step `skipped`
is dropped from the step breakdown (suppressed rows write no step key), and
the per-step queries now run concurrently. Frequency caps and journey
`meta.suppress` min-gap checks exclude `suppressed` rows exactly like
`failed` ones (neither reached the inbox). Studio renders the new status as
a dim (non-destructive) terminal chip and offers it in the sends filter.

Pre-existing suppressed rows (written as `failed`, keyless) are left as-is —
they are genuinely indistinguishable from historical provider failures; the
split is authoritative for rows written from this version on.
