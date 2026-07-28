# PRD 12 — Offboarding: export, destroy, eject (scoped; flesh out when popped)

## Scope
Trust-completing surfaces: full data export (pg_dump of the tenant DB to a time-limited
signed download, cloud-worker task; object-storage seam — local disk fallback in dev);
account/org deletion completing PRD 03's intent (grace period, then suspend → destroy
composed through StackService per PRD 02's transition law, drop DBs + purge rows, audit
trail retained); self-host eject guide surface (download export +
docs link + their scaffold is already their code — make the "same code, your infra" story
a first-class page).

Key invariants: export contains no OTHER tenant's data by construction (per-tenant DB
dividend — assert dump source DSN); deletion is two-step confirmed + delayed (72h cancel
window); suspended-for-nonpayment data retained 30 days before this flow auto-runs.

_Boundary:_ `apps/cloud`. _Depends:_ PRD 04 (06 for nonpayment path).
Seams: object storage for exports (Railway bucket or R2).

## Implementation Notes
