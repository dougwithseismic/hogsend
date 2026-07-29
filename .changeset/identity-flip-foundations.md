---
"@hogsend/core": minor
"@hogsend/db": minor
"@hogsend/engine": minor
---

Identity flip foundations (PRD 05, T1–T3). `@hogsend/core` gains `bySubject(table, { contactId, userKey })` — the either/or history read scope (`contact_id` when the owner is known, the string `user_id` otherwise; never OR) — and `ConditionContext` now requires `contactId`. The four contact relations join `contact_id → contacts.id` instead of `user_id → contacts.external_id`. Merge/adoption paths stamp `contact_id` inside the same UPDATE that rewrites `user_id` (NULL-guarded: an owned row is never re-parented). Migration 0071 adds three contact-scoped partial unique indexes (`WHERE contact_id IS NOT NULL`) on live journey enrollments, live bucket memberships and email preferences; enrollment and both preference writers catch-and-convert the one 23505 the retained string arbiters cannot see. The contact-id backfill sweep skips stamps that would collide (reported by the verify probe as `duplicates`, not `missing`, so `flipReady` still drains), folds stale preference opt-outs into the stamped twin, and merge folds dedupe by structural owner so a survivor row stamped under a stale key can never be duplicated. Run `packages/db/scripts/preflight-contact-uniqueness.sql` (three zero-row queries) before migrating a large deployment.
