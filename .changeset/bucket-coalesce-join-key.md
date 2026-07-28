---
"@hogsend/engine": patch
---

Bucket criteria now read the contact behind an email-only or anonymous member.

`bucket_memberships.user_id` holds the canonical contact key
(`external_id ?? anonymous_id ?? id`), but the real-time membership check looked
that contact up by `external_id` alone. A contact whose canonical key is not its
`external_id` — an email-only contact keyed on its uuid, or an anonymous one
keyed on its `anonymous_id` — was never found, and two things followed.

Property criteria evaluated against `{}` instead of the person's real state, so
every property leg silently answered "absent" for them. A bucket asking for
`plan == "pro"` never matched a member who genuinely was on Pro.

More seriously, the soft-delete guard is driven by the row that lookup returns.
When the lookup found nothing, `deleted_at` was never read, so a **soft-deleted**
email-only or anonymous contact could still transition buckets and emit
`bucket:entered` / `bucket:left` — the one thing that guard exists to prevent.

Both now resolve on the same `coalesce(external_id, anonymous_id, id)`
expression the cron's join scan already uses. That scan was corrected for
exactly this reason, and its comment says why: joining on `external_id` "would
silently drop exactly the dormant email-only contacts this cron exists to
reconcile". This applies the same correction to the real-time path.

**What you may observe.** Buckets with property criteria start matching
email-only and anonymous members who genuinely satisfy them and were previously
invisible, so those buckets can gain members. The change is incremental — each
affected contact is re-evaluated when they next generate an event, not in a
sweep — so there is no backlog burst. Soft-deleted contacts stop transitioning
entirely.

**Known, and deliberately not fixed here.** The cron's leave, TTL and dwell
passes still join `external_id`, so such a member enrolled by the cron is still
never left or dwell-fired by it. That fix needs a first-tick guard: a member
sitting past its `maxDwell` for months would otherwise fire immediately, and a
dwell reaction is a full journey that can send email — a backlog of months-old
lifecycle messages to real recipients. The same `external_id` join also affects
the bucket accessor (`count`/`has`/`members`) and the campaign audience query,
the latter changing who receives a broadcast. Those carry different blast
profiles and are handled separately rather than bundled here.
