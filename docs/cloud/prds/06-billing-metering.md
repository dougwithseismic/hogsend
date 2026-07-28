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

## Tasks (fleshed at pop)
1. **Engine: ingest-suspend flag + pool cap** — `HOGSEND_INGEST_SUSPENDED=true` →
   `/v1/events` 429 `{ error: "ingest_suspended", detail }` (documented body, tests,
   transactional-webhook routes unaffected); `DATABASE_POOL_MAX` read by
   `createDatabase` (default 10 unchanged). _Boundary:_ `packages/engine` +
   `packages/db`. _Depends:_ —
2. **BillingProvider seam + Stripe** — `src/billing/` mirror of the substrate pattern:
   Fake + Stripe impls (checkout session create, subscription lifecycle webhook w/
   signature fail-closed, plan mapping via env price IDs), plan-change service
   (trial→paid, upgrade to dedicated marks stack for re-provision — defer the actual
   migration to PRD 11, park the stack note), dunning state on org (grace 14d →
   suspend). _Boundary:_ apps/cloud. _Depends:_ —
3. **Metering + enforcement + Usage UI** — nightly cloud-worker sweep reading per-tenant
   counts via the stack's stored tenant DSN (read-only role); upsert usage_counters;
   soft-block = setEnv HOGSEND_INGEST_SUSPENDED on cap breach (+ un-set on new month /
   upgrade); trial-expiry → suspend; Usage page (per-env counters vs plan limits, ds
   bars, no chart lib); overage banners; checkout/upgrade surfaces wired to task 2.
   _Boundary:_ apps/cloud. _Depends:_ 1, 2.

## Implementation Notes
