---
"@hogsend/engine": patch
"@hogsend/studio": patch
---

Attribution coverage: `GET /v1/admin/attribution` now returns per-currency `totals` (fired vs attributed conversion value and counts), and the Studio Attribution tab shows an explicit Unattributed bar, a coverage line, and a conversion-point scope select — so the tab's numbers reconcile with the revenue cards instead of silently omitting conversions that had no touchpoint path.
