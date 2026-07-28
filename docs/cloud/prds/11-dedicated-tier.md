# PRD 11 — Dedicated tier: rung-0, custom domains, EU (scoped; flesh out when popped)

## Scope
The $149 differentiators. Dedicated provision spec: private Postgres + private
hatchet-lite (+ its PG) inside the org's Railway project instead of shared-cluster/
shared-Hatchet — same `SubstrateProvider.provisionStack` with a `topology: "dedicated"`
spec branch, FakeSubstrate parity. Region: `europe-west4` per-service placement for EU
orgs (region already on org row). Custom tracking domain: dashboard flow → CNAME+TXT
instructions → `attachDomain` (Railway customDomainCreate) → verify loop → stack env
`API_PUBLIC_URL`/tracking host update + redeploy. Plan upgrade path self-serve → dedicated
= re-provision with data migration (pg_dump/restore task, downtime window surfaced) — may
defer migration to a follow-up if scope demands, but spec the decision when popped.

Key invariants: domain verification fail-open never breaks sends (falls back to default
host); EU org's stack + tenant data never lands on US services (assert region on every
substrate call in tests).

_Boundary:_ `apps/cloud`. _Depends:_ PRD 04, 06.

## Implementation Notes
