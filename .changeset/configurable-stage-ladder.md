---
"@hogsend/core": minor
"@hogsend/engine": minor
"@hogsend/studio": minor
---

Configurable pipeline ladder — the canonical deal funnel is now yours to define. `createHogsendClient({ crm: { stages: ["trial", "demo", "poc", "won"], quotedStage: "poc", soldStage: "won" } })` replaces the built-in `lead → contacted → survey_booked → quoted → sold` wholesale: rank from array order, `"lost"` stays the implicit terminal, zero migration (only new stage events re-rank). The money-event NAMES stay stable across any ladder (`crm.deal_quoted` = the designated money-signal stage, `crm.deal_sold` = the designated realized stage — custom ladders default it to their LAST stage), so journeys and conversion points never chase your naming. Stage maps are boot-validated against the configured ladder (a value outside it throws with the exact path). `@hogsend/core` gains `PipelineLadder` / `DEFAULT_PIPELINE_LADDER` / `normalizePipelineLadder`; `canonicalStageRank` and `resolveCanonicalStage` take the ladder (a provider `won` status hint resolves to YOUR sold stage). Admin `GET /v1/admin/deals/stats` serves the ladder as `stageOrder`; Studio's Deals board and the contact `dealStage` filter render whatever ladder is configured.
