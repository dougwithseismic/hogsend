---
"@hogsend/engine": minor
"@hogsend/studio": patch
---

Campaign send stats now attribute via the indexed `email_sends.campaign_id`
column instead of LIKE-scanning the idempotency key (fixes #572). The column
has been the designed carrier since migration 0051 backfilled it — the key is
dedup-only, and suppressed sends never write one, so a key scan could never
see them.

Switched read sites: the admin campaign stats aggregate + per-step breakdown
(the step number still lives only in the key, so step rows anchor on the
step-scoped pattern scoped to the FK first), the Impact overview campaigns
rollup (the `split_part` + UUID-guard parsing is gone), the admin emails
`?campaignId=` filter (now uuid-validated), and campaign-wave engagement
cohorts.

Campaign stats gain an additive `skipped` count: keyless FK-attributed rows —
suppressed or test-mode-blocked sends that were never dispatched. `sends` and
`failed` are now explicitly scoped to keyed rows so they keep meaning
"dispatch attempts"/"dispatch failures" (suppression shares the row-level
`failed` status). Studio's `CampaignStats`/`CampaignStepStats` types carry the
new field.
