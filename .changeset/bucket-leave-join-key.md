---
"@hogsend/engine": minor
"@hogsend/db": minor
---

Bucket leave and dwell passes now see members keyed on anything but `external_id`.

`bucket_memberships.user_id` holds the canonical contact key
(`external_id ?? anonymous_id ?? id`), but every leave, TTL, dwell and re-eval
query joined `contacts.external_id = bucket_memberships.user_id`. A contact
whose canonical key is not its `external_id` — an email-only contact keyed on
its uuid, or an anonymous one keyed on its `anonymous_id` — was therefore a
one-way door: the join scan already reads the coalesce key, so it could be
enrolled, but it was never left, never dwell-fired and never re-evaluated. Its
`maxDwell` TTL never expired and its dwell schedules never ran. The join scan
was corrected for exactly this reason and the leave side was never brought
along; the comment there already says joining on `external_id` "would silently
drop exactly the dormant email-only contacts this cron exists to reconcile".

Nine queries now join on the same `coalesce(external_id, anonymous_id, id)` key: the five cron
passes above, and the bucket accessor's `count()`, `has()` and `members()` (two queries). Those move
TOGETHER on purpose. Correcting the cron alone would make it act on members the accessor still could
not see — dwell fires and leave emissions for people `count()` reports as absent, and `has()`
returning false for a real member. A non-obvious divergence introduced by the fix is worse than the
consistent blind spot it replaces. The accessor sites are pure reads: they emit nothing and change no
membership, so they carry none of the first-tick hazard below.

Correcting it makes a previously-stranded cohort due all at once, and a dwell
reaction is a full journey that can send email, so the first tick would deliver
a backlog of months-old lifecycle messages. It does not. The first sweep after
this upgrade claims that cohort per bucket and resets its membership-age clocks
to that instant — the dwell anchor moves to now, dwell stamps clear, and a
`maxDwell` TTL is re-armed a full window out — then skips that bucket for that
one tick. Nothing is emitted and nothing is silently swallowed: every age-driven
emission still happens, measured from the moment the cron could first see the
member. Criteria-driven leaves are deliberately not deferred, because they
evaluate against present-day events rather than membership age.

The claim is recorded on a new nullable `bucket_configs.coalesce_claimed_at`
column so it runs exactly once per bucket. It runs even when the cohort is
empty, which costs a new deployment one no-op reconcile tick per bucket, once.

**What you will observe.** Buckets containing email-only or anonymous members
report leaves and dwell fires that previously never arrived. If you have such
members sitting far past a `maxDwell`, expect their leave one full `maxDwell`
window after the upgrade rather than immediately.

Known remaining asymmetry, unchanged here: the campaign audience query for a bucket still joins
`external_id`, so a bucket-targeted campaign still omits these members. Correcting it changes who
receives a broadcast, so it is a product decision and is deliberately not bundled.
