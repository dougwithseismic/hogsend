# PRD 02 — Tenant model + secrets

## Goal
The cloud database schema and service layer for the whole product: organizations,
environments, stacks with a strict lifecycle state machine, plans/subscription snapshots,
encrypted provider keys, and audit events. Pure data + logic — no UI, no substrate calls.

## Locked decisions (this PRD)
- Tables (all tenant tables `organization_id NOT NULL` + FK, timestamps, soft-delete only
  where stated):
  - `cells` — shared-infra region cells (DECISIONS §2): `region`, `sharedClusterDsn`
    (encrypted), `sharedHatchetUrl`, `accepting`, `maxTenants`. Seeded by ops, read by
    signup + provisioner. NOT org-scoped.
  - `organizations` mirror table keyed by Better Auth org id (region `us|eu`, plan
    `trial|self_serve|dedicated`, `cell_id` FK nullable — null for dedicated,
    `suspended_at`, `trial_ends_at`).
  - `environments` — `(organization_id, name)` unique; `kind: production|staging|test`;
    exactly one `production` per org enforced in service layer.
  - `stacks` — 1:1 with environment (unique FK); `status` enum:
    `requested → provisioning → running → publishing → suspended → destroying → destroyed`,
    plus `error` (with `last_error` text + `retry_count`). Legal edges explicitly include
    `running → suspended`, `suspended → running` (resume), `error → provisioning` (retry),
    and destroy is reachable ONLY from `suspended` — deletion flows (PRDs 09/12) compose
    suspend → destroy, never a direct `running → destroying` edge; substrate refs as OPAQUE jsonb
    (`substrate_refs`) — no Railway-shaped columns; `engine_version` (locked at publish);
    `hatchet_namespace`, `db_name` (shared cluster), `region`.
  - `provider_keys` — per environment; `provider` (resend/postmark/posthog/twilio/…),
    `encrypted_payload` (AES-256-GCM via `CLOUD_ENCRYPTION_SECRET`, engine's
    provider-credentials crypto pattern), `last4` for display, `verified_at`.
  - `usage_counters` — per environment per month: `events_count`, `emails_count`
    (upsert-increment; metering source lands PRD 06).
  - `cloud_audit_log` — actor, org, action, subject, jsonb detail.
- **State machine is the law**: transitions only via `StackService.transition()` which
  validates legality (illegal transition = typed error), writes audit log, and is the ONLY
  writer of `stacks.status`.
- Crypto helpers in `apps/cloud/src/lib/crypto.ts`; round-trip + tamper tests required.
- Zod schemas for all service inputs; services are single-object-in/result-object-out
  (repo idiom).

## EARS acceptance criteria
- WHEN an organization is created via `OrgService.create`, the system SHALL create the org
  row (region, plan `trial`, `trial_ends_at = now + 14d`) AND its `production` environment
  AND a stack in `requested`, atomically.
- WHEN a second `production` environment is attempted, the system SHALL reject with a typed
  error and create nothing.
- WHEN `StackService.transition(stack, to)` is called with an illegal edge (e.g.
  `destroyed → running`), the system SHALL throw `IllegalTransitionError` and leave the row
  unchanged.
- WHEN a provider key is stored, the system SHALL persist only ciphertext + last4, and
  `getDecrypted` SHALL round-trip the exact payload; a tampered ciphertext SHALL fail
  closed.
- WHEN environment count exceeds the org's plan allowance (trial 1 / self-serve 2 /
  dedicated 4), the system SHALL reject creation with `PlanLimitError`.
- WHEN any service mutation succeeds, the system SHALL append a `cloud_audit_log` row.

## Tasks
1. **Schema + migration 0001** — all tables above, enums, indexes (org lookups, stack
   status), generated via drizzle-kit; migration idempotency test.
   _Boundary:_ `apps/cloud`. _Depends:_ PRD 01
2. **Crypto + provider-key service** — AES-256-GCM helpers (TDD: round-trip, tamper,
   wrong-secret), `ProviderKeyService` store/list/getDecrypted/delete.
   _Boundary:_ `apps/cloud`. _Depends:_ 1
3. **Org/Environment services + plan limits** — `OrgService.create` (atomic trio),
   `EnvironmentService` create/list/delete with plan-allowance + single-production rules.
   _Boundary:_ `apps/cloud`. _Depends:_ 1
4. **Stack state machine + audit** — transition table, `StackService` (create/transition/
   recordError/get), audit-log writer, exhaustive transition tests (legal + illegal
   matrix).
   _Boundary:_ `apps/cloud`. _Depends:_ 1

## Seams
None — pure DB + logic against local Postgres.

## Done when
EARS green under vitest; gates green; no substrate imports anywhere in this layer.

## Implementation Notes
Shipped in 4 commits (schema 0001 / crypto+keys 0002 / org+env services / state machine).
139 tests total on close. Deltas + laws discovered: all tables live in a `cloud` pg
schema; org pk = Better Auth org id TEXT (no mapping table); provider_keys upsert
arbiter (environment_id, provider) added in 0002 — one key per provider per env,
replace-on-store resets verified_at; crypto is `v1:`-prefixed AES-256-GCM mirroring the
engine's construction, fail-closed with a no-oracle `CloudDecryptError`; audit detail
excludes even last4. Transition enforcement is a single guarded UPDATE
(`WHERE status IN legalSources(to)`) — concurrency-safe without SELECT-then-write; the
full edge table incl. error→destroying (tear down a failed half-provision) lives in
`stacks.ts` as exported data (`LEGAL_EDGES`/`legalSources`) for PRD 04. Stack rows are
CREATED (status requested) by org/env services — creation is not a transition. Enum
values are frozen in PG order; future statuses must be APPENDED.
