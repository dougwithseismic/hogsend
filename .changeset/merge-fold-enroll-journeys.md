---
"@hogsend/engine": minor
---

The contact resolver's merge fold can now opt out of the journey plane. A merge that drops a live linked account re-ingests `account.unlinked` so a journey can trigger on it — correct for an organic resolve, but a bulk import folds many rows at once and would fan out one enrolment per merged row that dropped a live link.

`ResolveContactOptions` gains `enrollJourneys` (default `true`, so organic ingest is unchanged); the built-in contact importer passes `false`. The gate suppresses only the journey plane — the outbound `account.unlinked` webhook still fires on both paths, so a subscriber's mirror converges whether the change arrived by import or by live traffic. Mirrors the `POST /v1/accounts/import` route's own `enrollJourneys` default-off.
