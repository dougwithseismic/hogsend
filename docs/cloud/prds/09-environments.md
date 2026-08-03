# PRD 09 — Environments (Stripe-sandbox-style) (scoped; flesh out when popped)

## Scope
Full environments UX on top of the model that already exists in PRD 02/04: create
staging/test environments (plan-allowance gated), each provisioning its own stack via the
PRD 04 pipeline; test envs get `HOGSEND_TEST_MODE=true` + `HOGSEND_TEST_EMAIL/PHONE`
prompts; per-environment API keys/ingest URLs surfaced; environment switcher across the
dashboard; `hogsend publish --env staging` (PRD 07 flag) targeting the right stack;
promote flow = publish the same build record to prod (image reuse, no rebuild); delete
environment (composes suspend → destroy through StackService per PRD 02's transition
law — never a direct running→destroying edge; prod undeletable).

Key invariants: test envs can never hold a verified production Resend key silently — key
scope is per-environment (PRD 02 already scopes provider_keys to environment); promote
reuses the exact image digest.

_Boundary:_ `apps/cloud` (+ small `packages/cli` flag work). _Depends:_ PRD 05, 07, 08.

## Implementation Notes
