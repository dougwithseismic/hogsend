---
"@hogsend/core": minor
"@hogsend/engine": minor
"@hogsend/studio": minor
---

Configurable pipeline ladder — the canonical deal funnel is now yours to define. `createHogsendClient({ crm: { stages: ["trial", "demo", { id: "poc", milestone: "quoted" }, { id: "won", milestone: "won" }] } })` replaces the built-in `lead → contacted → survey_booked → quoted → sold` wholesale: rank from array order, `"lost"` stays the implicit terminal, zero migration (only new stage events re-rank). Money milestones sit ON the stage entries (`milestone: "quoted" | "won"`); all-string arrays keep the legacy defaults (soldStage = last stage, quotedStage = a stage literally named `"quoted"`). The money-event NAMES stay stable across any ladder (`deal.quoted` = the designated money-signal stage, `deal.sold` = the designated realized stage), so journeys and conversion points never chase your naming. Stage maps are boot-validated against the configured ladder (a value outside it throws with the exact path). `@hogsend/core` gains `PipelineLadder` / `DEFAULT_PIPELINE_LADDER` / `normalizePipelineLadder` / `canonicalStageRank` (ladder-aware; a provider `won` status hint resolves to YOUR sold stage). Admin `GET /v1/admin/deals/stats` serves the ladder as `stageOrder`; Studio's Deals board and the contact `dealStage` filter render whatever ladder is configured.
