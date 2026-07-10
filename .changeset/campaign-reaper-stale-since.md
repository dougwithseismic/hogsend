---
"@hogsend/engine": patch
"@hogsend/core": patch
"@hogsend/email": patch
"@hogsend/db": patch
"@hogsend/cli": patch
"@hogsend/client": patch
"@hogsend/js": patch
"@hogsend/react": patch
"@hogsend/plugin-posthog": patch
"@hogsend/plugin-resend": patch
"@hogsend/plugin-postmark": patch
"@hogsend/plugin-discord": patch
"@hogsend/plugin-telegram": patch
"@hogsend/studio": patch
"hogsend": patch
"create-hogsend": patch
---

Campaign reaper: the in-flight (`queued`/`sending`) give-up now actually fires for poison campaigns.

The give-up window was measured from `updatedAt`, but the stale sweep's own re-enqueue bumps `updatedAt` as its re-pick guard — so a deterministically-crashing campaign was re-bumped every cycle and could never age past the window (the give-up was dead code for in-flight rows). New nullable `campaigns.stale_since` column (migration 0042) separates "when did progress last happen" from "when did we last poke it": the stale sweep coalesce-sets it once on the first re-enqueue, every genuine progress flush of the send task clears it back to NULL, and the crash-path flush preserves it. The give-up clause reads `stale_since < now() - CAMPAIGN_GIVE_UP_AFTER_MS` — "continuously stuck for 6h with zero progress", which is what the docstring always claimed. `scheduled`/`waiting` give-ups are unchanged (still measured from `scheduledAt`/`nextStepAt`).
