# PRD 06 — Billing + metering (scoped; flesh out when popped)

## Scope
Stripe subscriptions for the two paid tiers + trial handling, and usage metering that
enforces DECISIONS §2 limits. `BillingProvider` seam (Fake + Stripe) mirroring the
substrate pattern; Stripe test mode first. Checkout from plan-pick / upgrade surfaces;
webhook handler (checkout completed, subscription updated/canceled, payment failed →
dunning state → suspend after grace). Metering: nightly cloud-worker task reads per-tenant
counts (events + email_sends deltas) connecting via the tenant DB DSN recorded on the
stack at provision time (a read-only role; works identically for shared-cluster and
dedicated private-Postgres topologies — PRD 11's dedicated provision must persist a
metering-reachable DSN) and upserts `usage_counters`. Ingest soft-block = the
`HOGSEND_INGEST_SUSPENDED=true → /v1/events 429` engine flag per DECISIONS §2 — this
PRD's boundary explicitly includes that small `packages/engine` change (flag + 429 body +
tests), driven via `SubstrateProvider.setEnv` + redeploy. Same engine change batch adds
`DATABASE_POOL_MAX` (read by `createDatabase` — PRD 04 found DSN pool params are silently
ignored; tenant stacks on shared cells need max 3, not the hardcoded 10). Dashboard Usage page (dataviz skill for charts); overage banners; trial-expiry
lifecycle (suspend stack, keep data 30 days).

Key invariants: no plan enforcement bypass via API; metering reads never write tenant DBs;
Stripe webhook signature verified fail-closed; all billing state transitions audit-logged.

_Boundary:_ `apps/cloud` + `packages/engine` (the ingest-suspend flag only). _Depends:_
PRD 04 (05 for upgrade surfaces).
Seams: Stripe keys (test-mode first), price IDs.

## Implementation Notes
